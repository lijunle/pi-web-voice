"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { transcribe, termBudget } = require("./providers.cjs");
const { collectTerms } = require("./context.cjs");

const INJECT_FILE = path.join(__dirname, "..", "public", "inject.js");

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`audio exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Settings the browser needs. Credentials never leave the server: the page
 * only learns which provider is configured, never its key.
 */
function browserConfig(config) {
  return { prefix: config.prefix, provider: config.provider };
}

/**
 * Language hints for the models that accept several. The browser already says
 * what it speaks, so nothing needs configuring; English is always included
 * because the terms themselves are English.
 */
function languageHints(req) {
  const header = String(req.headers["accept-language"] ?? "");
  const languages = header
    .split(",")
    .map((part) => part.split(";")[0].trim().split("-")[0].toLowerCase())
    .filter((tag) => /^[a-z]{2,3}$/.test(tag));
  return [...new Set([...languages, "en"])].slice(0, 3);
}

function createRouter(config) {
  return async function handleRoute(req, res) {
    const url = new URL(req.url, "http://localhost");
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
      try {
        const audio = await readBody(req, config.limits.maxBytes);
        if (audio.length === 0) return json(res, 400, { error: "empty audio" });

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
        // Metadata only, never the transcript: enough to see how it is doing
        // over a week without writing anything you said into a log file.
        console.log(
          `[pi-web-voice] ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
            `${(audio.length / 32000).toFixed(1)}s audio · ${terms.length} terms · ` +
            `${text.length} chars · ${languages.join("/")}` +
            (Number.isFinite(waited) && waited > 0 ? ` · mic opened in ${waited}ms` : ""),
        );
        json(res, 200, {
          text,
          ms: Date.now() - started,
          provider: config.provider,
          terms: terms.length,
        });
      } catch (error) {
        console.error("[pi-web-voice] transcribe failed:", error.message);
        json(res, 502, { error: error.message });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  };
}

module.exports = { createRouter };
