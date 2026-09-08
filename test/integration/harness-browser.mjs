/** Exercise the test driver's failure paths with Chromium and loopback services only. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { openBrowser } from "../helpers/browser.mjs";
import { waitFor } from "../helpers/async.mjs";
import { guardNetwork } from "../helpers/voice-page.mjs";
import { readResponseBody } from "../helpers/round-trip.mjs";

let posts = 0;
const server = http.createServer((req, res) => {
  if (req.method === "POST") posts++;
  if (req.url === "/slow") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"text":"'); // Headers arrive; body completion stalls until cleanup.
  } else if (req.url === "/invalid") {
    res.end("PRIVATE_PROVIDER_RESPONSE{");
  } else {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Isolated driver fixture</title>");
  }
});
let browser;
let checks = 0;
function check(name, condition = true) {
  assert.ok(condition, name);
  checks++;
  console.log(`ok  ${name}`);
}
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const driver = await openBrowser({ signal: controller.signal });
  browser = driver.browser;
  const { page } = driver;
  const traffic = await guardNetwork(page, origin, { live: true });
  await page.goto(origin);
  const post = path => page.evaluate(async path => {
    try { return (await fetch(path, { method: "POST", body: "synthetic fixture" })).ok; }
    catch { return false; }
  }, path);
  check("live guard blocks early uploads before the server sees them", !await post("/__voice/transcribe") && posts === 0);
  traffic.finishSetup();
  traffic.permitUpload();
  check("live guard permits one deliberate request", await post("/__voice/transcribe") && posts === 1);
  const duplicates = await Promise.all([post("/__voice/transcribe"), post("/__voice/transcribe")]);
  check("live guard blocks simultaneous duplicate uploads before server dispatch", duplicates.every(ok => !ok) && posts === 1);
  await post("/api/agent/new");
  await post("https://example.invalid/agent");
  check("agent and external writes are blocked and counted", posts === 1 && traffic.violations.length === 5);

  await assert.rejects(waitFor(() => page.evaluate(() => new Promise(() => {})), "stalled browser evaluation", 50), /waiting for stalled browser evaluation/);
  check("a pending Playwright evaluation respects the polling deadline");

  const slowResponse = page.waitForResponse(response => response.url() === `${origin}/slow`);
  await page.evaluate(() => { void fetch("/slow").catch(() => {}); });
  await assert.rejects(readResponseBody(await slowResponse, 50), /Timed out: transcription response body/);
  check("real HTTP headers do not bypass the body deadline");

  const invalidResponse = page.waitForResponse(response => response.url() === `${origin}/invalid`);
  await page.evaluate(() => { void fetch("/invalid").catch(() => {}); });
  await assert.rejects(readResponseBody(await invalidResponse), error =>
    error.message === "Transcription response contains invalid JSON" && !error.stack.includes("PRIVATE_PROVIDER_RESPONSE"));
  check("real malformed responses keep provider bytes out of the test error");

  controller.abort();
  await waitFor(() => !browser.isConnected(), "aborted browser closure");
  check("host cancellation closes its browser even during pending protocol work");
  console.log(`\n${checks}/${checks} browser harness checks passed`);
} finally {
  try { await browser?.close(); }
  finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
