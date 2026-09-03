"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { transcribe } = require("./providers.cjs");

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
  return {
    prefix: config.prefix,
    provider: config.provider,
    ...config.ui,
  };
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
      json(res, 200, { ok: true, provider: config.provider, terms: config.terms.length });
      return;
    }

    if (route === "/transcribe") {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      const started = Date.now();
      try {
        const audio = await readBody(req, config.limits.maxBytes);
        if (audio.length === 0) return json(res, 400, { error: "empty audio" });

        const text = await transcribe(audio, config);
        json(res, 200, { text, ms: Date.now() - started, provider: config.provider });
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
