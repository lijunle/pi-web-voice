"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { transcribe, termBudget } = require("./providers.cjs");
const { analyzePcmWav } = require("./audio.cjs");
const { collectTerms } = require("./context.cjs");
const { errorMessage, errorStatus } = require("./guards.cjs");

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {ReturnType<typeof import("./config.cjs").loadConfig>} VoiceConfig */
/** @typedef {(req: IncomingMessage, res: ServerResponse) => Promise<void>} VoiceRouter */

const INJECT_FILE = path.join(__dirname, "..", "public", "inject.js");

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    // Validate the stream boundary even if a custom request changes its encoding.
    req.on("data", /** @param {unknown} chunk */ (chunk) => {
      try {
        if (!Buffer.isBuffer(chunk)) throw new TypeError("audio stream must emit Buffer chunks");
        size += chunk.length;
        if (size > maxBytes) throw new Error(`audio exceeds ${maxBytes} bytes`);
        chunks.push(chunk);
      } catch (error) {
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Settings the browser needs. Credentials never leave the server: the page
 * only learns which provider is configured, never its key.
 * @param {VoiceConfig} config
 */
function browserConfig(config) {
  return { prefix: config.prefix, provider: config.provider };
}

/**
 * Keep up to three primary language tags, appending English when space permits.
 * @param {IncomingMessage} req
 */
function languageHints(req) {
  const header = String(req.headers["accept-language"] ?? "");
  const languages = header
    .split(",")
    .map((part) => part.split(";")[0].trim().split("-")[0].toLowerCase())
    .filter((tag) => /^[a-z]{2,3}$/.test(tag));
  return [...new Set([...languages, "en"])].slice(0, 3);
}

/**
 * @param {VoiceConfig} config
 * @returns {VoiceRouter}
 */
function createRouter(config) {
  return async function handleRoute(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.slice(config.prefix.length) || "/";

    if (route === "/inject.js") {
      // Read on every request so editing inject.js takes effect on reload,
      // with no restart of pi-web.
      const source = await fs.readFile(INJECT_FILE, "utf8");
      const preamble = `window.__PI_WEB_VOICE__=${JSON.stringify(browserConfig(config))};\n`;
      const body = preamble + source;
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (route === "/health") {
      json(res, 200, { ok: true, provider: config.provider });
      return;
    }

    // Shows exactly which vocabulary a session would send. Useful for tuning,
    // and for seeing what leaves the machine before it does.
    if (route === "/terms") {
      const sessionId = url.searchParams.get("session") ?? "";
      const cwd = url.searchParams.get("cwd") ?? "";
      const limit = Math.min(config.context.maxTerms, termBudget(config.provider));
      const terms = collectTerms(sessionId, cwd, config, limit);
      json(res, 200, { sessionId, cwd, count: terms.length, terms });
      return;
    }

    if (route === "/transcribe") {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      const started = Date.now();
      const requestId = randomUUID();
      // This is a client-reported policy, not proof of browser audio health.
      // Older pages omit it; never copy arbitrary query text into service logs.
      const audioContext = url.searchParams.get("audio_context") === "per-take" ? "per-take" : "unspecified";
      // All adapters leave chunking/VAD at provider defaults; this is not VAD-off.
      const label =
        `[pi-web-voice] ${new Date(started).toISOString()} · request=${requestId} · audio_context=${audioContext} · ` +
        `provider=${config.provider} · vad=default`;
      res.setHeader("x-pi-voice-request-id", requestId);
      let gateLog = "audio_gate=unchecked";
      try {
        const audio = await readBody(req, config.limits.maxBytes);
        if (audio.length === 0) {
          console.log(`${label} · result=rejected · reason=empty-audio`);
          return json(res, 400, { error: "empty audio" });
        }

        // A bypass applies only to this HTTP request. Keep it separate from
        // provider fields and from proof that a human clicked a browser control.
        const bypass = req.headers["x-pi-voice-silence-check"] === "bypass";
        const signal = bypass ? null : analyzePcmWav(audio);
        const gate = bypass ? "bypass" : signal ? (signal.silent ? "silence" : "signal") : "unknown";
        gateLog = `audio_gate=${gate}`;
        if (signal) {
          gateLog += ` · audio_samples=${signal.samples} · audio_peak=${signal.peak.toFixed(6)}` +
            ` · audio_rms_max=${signal.maxRms.toFixed(6)}`;
        }
        if (signal?.silent) {
          console.log(
            `${label} · result=skipped · reason=silence · ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
              `${gateLog} · upstream=not-called`,
          );
          // An explicit error keeps the WAV even in older clients. Updated
          // clients offer a deliberate, single-request bypass of this gate.
          return json(res, 422, {
            code: "silence_detected",
            error: "No audible signal detected; speech service not called. Recording kept for retry.",
          });
        }

        const sessionId = url.searchParams.get("session") ?? "";
        const cwd = url.searchParams.get("cwd") ?? "";
        const limit = Math.min(config.context.maxTerms, termBudget(config.provider));
        const terms = collectTerms(sessionId, cwd, config, limit);
        const languages = languageHints(req);
        // The browser measures how long its press waited for the microphone;
        // nothing else can see that number, and it is the part of the delay a
        // user actually feels.
        const waited = Number(url.searchParams.get("wait"));

        const text = await transcribe(audio, config, terms, languages);
        const ms = Date.now() - started;
        // An empty response is observable; whether VAD rejected speech is not.
        // Log that distinction and counts only, never the transcript or terms.
        console.log(
          `${label} · result=${text ? "transcribed" : "empty"} · ${(ms / 1000).toFixed(1)}s · ` +
            `${(audio.length / 32000).toFixed(1)}s audio · ${terms.length} terms · ` +
            `${text.length} chars · ${languages.join("/")} · ${gateLog}` +
            (Number.isFinite(waited) && waited > 0 ? ` · mic opened in ${waited}ms` : ""),
        );
        json(res, 200, {
          text,
          ms,
          provider: config.provider,
          terms: terms.length,
        });
      } catch (error) {
        // The upstream message still reaches the caller, but not the service
        // log: provider error bodies can contain private request content.
        const status = errorStatus(error) ?? "n/a";
        console.error(
          `${label} · result=error · ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
            `${gateLog} · upstream_status=${status}`,
        );
        json(res, 502, { error: errorMessage(error) });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  };
}

module.exports = { createRouter };
