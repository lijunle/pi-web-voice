import assert from "node:assert/strict";
import test from "node:test";
import { readResponseBody } from "../helpers/round-trip.mjs";

test("the browser test reader reads text once and parses valid JSON", async () => {
  let reads = 0;
  const response = { text: async () => { reads++; return '{"text":"fixture"}'; } };
  assert.deepEqual(await readResponseBody(response), { text: "fixture" });
  assert.equal(reads, 1);
});

test("a stalled response body has its own timeout after headers arrive", async () => {
  await assert.rejects(readResponseBody({ text: () => new Promise(() => {}) }, 20), /Timed out: transcription response body/);
});

test("malformed JSON produces a stable diagnosis without provider body snippets", async () => {
  await assert.rejects(readResponseBody({ text: async () => 'PRIVATE_PROVIDER_RESPONSE{' }), error => {
    assert.equal(error.message, "Transcription response contains invalid JSON");
    assert.ok(!error.stack.includes("PRIVATE_PROVIDER_RESPONSE"));
    return true;
  });
});

test("body read failures do not expose the transport's potentially private details", async () => {
  await assert.rejects(readResponseBody({ text: async () => { throw new Error("PRIVATE_ENDPOINT_KEY"); } }), error => {
    assert.equal(error.message, "Cannot read transcription response body");
    assert.ok(!error.stack.includes("PRIVATE_ENDPOINT_KEY"));
    return true;
  });
});
