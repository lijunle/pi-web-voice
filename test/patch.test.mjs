/**
 * Unit tests for the HTTP interception. No pi-web required: a throwaway server
 * stands in for it, exercising the response shapes pi-web actually produces.
 *
 *   node --test test/
 */

import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { install } = require("../lib/patch.cjs");

const PREFIX = "/__voice";
const TAG = `<script src="${PREFIX}/inject.js" defer></script>`;

let server;
let origin;

before(async () => {
  install({
    prefix: PREFIX,
    tag: TAG,
    handleRoute: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ route: req.url }));
    },
    onError: (error) => assert.fail(`hook error: ${error.message}`),
  });

  server = http.createServer((req, res) => {
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

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
