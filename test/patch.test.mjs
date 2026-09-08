/**
 * Unit tests for the HTTP interception. No pi-web required: a throwaway server
 * stands in for it, exercising the response shapes pi-web actually produces.
 *
 *   node --test test/
 */

import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import nodeTest from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { install } = require("../lib/patch.cjs");
const { loadConfig } = require("../lib/config.cjs");

const PREFIX = "/__voice";
const TAG = `<script src="${PREFIX}/inject.js" defer></script>`;

let origin;
const callbacks = [];
const headerGetterCounts = [];
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(5000) });

async function setup(t) {
  callbacks.length = 0;
  headerGetterCounts.length = 0;
  install({
    prefix: PREFIX,
    tag: TAG,
    handleRoute: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ route: req.url }));
    },
    onError: (error) => assert.fail(`hook error: ${error.message}`),
  });

  const server = http.createServer((req, res) => {
    if (req.url === "/html-compressed") {
      const body = gzipSync("<html><head></head><body>compressed</body></html>");
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": body.length });
      res.end(body);
      return;
    }
    if (req.url === "/html-utf16") {
      const body = Buffer.from("<html><head></head><body>中文</body></html>", "utf16le");
      res.writeHead(200, { "content-type": "text/html; charset=utf-16le", "content-length": body.length });
      res.end(body);
      return;
    }
    if (req.url === "/html-frozen-headers") {
      const body = "<html><head><title>İstanbul</title></head><body>frozen</body></html>";
      let reads = 0, typeReads = 0;
      const headers = Object.freeze({
        get "Content-Type"() { return ++typeReads === 1 ? "text/html" : "application/json"; },
        "Content-Length": Buffer.byteLength(body),
        get "x-fixture"() { reads += 1; return "fixture"; },
      });
      res.writeHead(200, headers);
      headerGetterCounts.push({ typeReads, reads });
      assert.equal(headers["Content-Length"], Buffer.byteLength(body));
      res.end(body);
      return;
    }
    if (req.url === "/html-search-limit") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write(Buffer.concat([Buffer.alloc(1024 * 1024 + 1, "a"), Buffer.from("中").subarray(0, 1)]));
      res.end(Buffer.concat([Buffer.from("中").subarray(1), Buffer.from("<body>tail</body>")]));
      return;
    }
    if (req.url === "/html-raw-headers") {
      const body = "<html><head></head><body>raw headers</body></html>";
      const headers = Object.freeze(["Content-Type", "text/html", "Content-Length", String(Buffer.byteLength(body))]);
      res.writeHead(200, "OK", headers);
      assert.equal(headers.length, 4);
      res.end(body);
      return;
    }
    if (req.url?.startsWith("/html-utf8-")) {
      const body = Buffer.from("<html><head></head><body>中文 😀 café</body></html>");
      const split = body.indexOf(Buffer.from("中文")) + 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write(body.subarray(0, split));
      if (req.url.endsWith("end")) res.end(body.subarray(split));
      else { res.write(body.subarray(split)); res.end(); }
      return;
    }
    if (req.url === "/html-uint8") {
      res.setHeader("content-type", "text/html");
      res.end(new Uint8Array(Buffer.from("<html><head></head><body>中文</body></html>")));
      return;
    }
    if (req.url === "/html-hex") {
      res.setHeader("content-type", "text/html");
      const body = "<html><head></head><body>中文</body></html>";
      res.end(Buffer.from(body).toString("hex"), "hex");
      return;
    }
    if (req.url === "/html-overloads") {
      assert.equal(res.writeHead(200, "OK", { "content-type": "text/html" }), res);
      res.write("<html><head>", () => callbacks.push("write"));
      assert.equal(res.end("</head><body>overloads</body></html>", "utf8", () => callbacks.push("end")), res);
      return;
    }
    if (req.url === "/json-overloads") {
      assert.equal(res.writeHead(200, ["content-type", "application/json"]), res);
      res.write('{"ok":true}', "utf8");
      assert.equal(res.end(() => callbacks.push("end-only")), res);
      return;
    }
    if (req.url === "/html-stream") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head><title>a</title>");
      res.write("</head><body>hi");
      res.end("</body></html>");
      return;
    }
    if (req.url === "/html-fixed") {
      const body = "<html><head></head><body>fixed</body></html>";
      res.writeHead(200, {
        "content-type": "text/html",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.url === "/html-nohead") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body class='x'>no head</body></html>");
      return;
    }
    if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accept: req.headers["accept-encoding"] ?? null, ok: true }));
      return;
    }
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 300);
      return;
    }
    if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    res.writeHead(404).end();
  });

  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}

// Explicit per-test setup also works on Node 20.0's test runner.
function test(name, run) {
  return nodeTest(name, { timeout: 10_000 }, async t => {
    await setup(t);
    await run(t);
  });
}

test("compressed HTML and explicit non-UTF-8 charsets pass through unchanged", async () => {
  const gzip = await fetch(`${origin}/html-compressed`);
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.equal(await gzip.text(), "<html><head></head><body>compressed</body></html>");
  const utf16 = await fetch(`${origin}/html-utf16`);
  const bytes = Buffer.from(await utf16.arrayBuffer());
  assert.equal(Number(utf16.headers.get("content-length")), bytes.length);
  assert.equal(bytes.toString("utf16le"), "<html><head></head><body>中文</body></html>");
});

test("immutable object headers and Unicode before the insertion point preserve HTML", async () => {
  const response = await fetch(`${origin}/html-frozen-headers`);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("content-type"), "text/html");
  assert.deepEqual(headerGetterCounts, [{ typeReads: 1, reads: 1 }]);
  assert.equal(await response.text(), `<html><head><title>İstanbul</title>${TAG}</head><body>frozen</body></html>`);
});

test("abandoning the insertion search still preserves partial UTF-8 at its boundary", async () => {
  const response = await fetch(`${origin}/html-search-limit`);
  assert.equal(await response.text(), "a".repeat(1024 * 1024 + 1) + "中<body>tail</body>");
});

test("HTML injection supports immutable raw header arrays and strips their content length", async () => {
  const response = await fetch(`${origin}/html-raw-headers`);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(await response.text(), `<html><head>${TAG}</head><body>raw headers</body></html>`);
});

for (const ending of ["write", "end"]) {
  test(`UTF-8 bytes split after the insertion point survive the ${ending} path`, async () => {
    const response = await fetch(`${origin}/html-utf8-${ending}`);
    assert.equal(await response.text(), `<html><head>${TAG}</head><body>中文 😀 café</body></html>`);
  });
}

for (const route of ["uint8", "hex"]) {
  test(`HTML injection honors ${route} response chunks`, async () => {
    const response = await fetch(`${origin}/html-${route}`);
    assert.equal(await response.text(), `<html><head>${TAG}</head><body>中文</body></html>`);
  });
}

test("HTTP wrappers preserve overloads, callbacks, and fluent return values", async () => {
  const html = await (await fetch(`${origin}/html-overloads`)).text();
  assert.equal(html.split(TAG).length - 1, 1);
  assert.match(html, /overloads/);
  assert.deepEqual(await (await fetch(`${origin}/json-overloads`)).json(), { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(callbacks, ["write", "end", "end-only"]);
});

test("server wrappers forward empty/custom events and listen options", async t => {
  const extra = http.createServer();
  t.after(() => new Promise(resolve => extra.close(resolve)));
  assert.equal(extra.emit("unused"), false);
  const eventArgs = [];
  extra.once("fixture", (...args) => eventArgs.push(...args));
  assert.equal(extra.emit("fixture", 42, "value"), true);
  assert.deepEqual(eventArgs, [42, "value"]);
  const symbol = Symbol("fixture event");
  extra.once(symbol, value => eventArgs.push(value));
  assert.equal(extra.emit(symbol, "symbol value"), true);
  assert.equal(eventArgs.at(-1), "symbol value");
  const listening = new Promise(resolve => extra.once("listening", resolve));
  assert.equal(extra.listen({ port: 0, host: "127.0.0.1" }), extra);
  await listening;
  assert.equal(extra.listening, true);
});

test("a ten-minute PCM recording fits within the upload and timeout limits", () => {
  const { limits } = loadConfig();
  const tenMinuteWavBytes = 44 + 10 * 60 * 16000 * 2;
  assert.ok(tenMinuteWavBytes < limits.maxBytes);
  assert.equal(limits.timeoutMs, 10 * 60_000);
});

test("serves its own routes without reaching the app", async () => {
  const response = await fetch(`${origin}${PREFIX}/anything`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { route: `${PREFIX}/anything` });
});

test("injects once into streamed HTML, before </head>", async () => {
  const html = await (await fetch(`${origin}/html-stream`)).text();
  assert.equal(html.split(TAG).length - 1, 1);
  assert.match(html, new RegExp(`${TAG.replace(/[/*+?^${}()|[\]\\]/g, "\\$&")}</head>`));
  assert.match(html, /<title>a<\/title>/);
  assert.match(html, /<\/body><\/html>$/);
});

test("drops content-length when the body grows", async () => {
  const response = await fetch(`${origin}/html-fixed`);
  assert.equal(response.headers.get("content-length"), null);
  const html = await response.text();
  assert.ok(html.includes(TAG));
  assert.ok(html.includes("fixed"));
});

test("falls back to <body> when there is no head", async () => {
  const html = await (await fetch(`${origin}/html-nohead`)).text();
  assert.match(html, /<body class='x'>\s*<script/);
});

test("leaves JSON byte-for-byte alone and strips accept-encoding", async () => {
  const response = await fetch(`${origin}/json`, { headers: { "accept-encoding": "gzip" } });
  const body = await response.json();
  assert.deepEqual(body, { accept: null, ok: true });
});

test("leaves binary responses alone", async () => {
  const bytes = new Uint8Array(await (await fetch(`${origin}/binary`)).arrayBuffer());
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("streams server-sent events without buffering", async () => {
  const response = await fetch(`${origin}/sse`);
  const reader = response.body.getReader();
  const first = await reader.read();
  // The first event must arrive while the response is still open.
  assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
  await reader.cancel();
});
