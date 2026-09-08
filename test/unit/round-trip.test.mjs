import assert from "node:assert/strict";
import test from "node:test";
import { assertRoundTrip } from "../helpers/round-trip.mjs";

const text = "[pi-web-voice mock] received 32044 bytes";
const success = () => ({
  body: { provider: "mock", text }, composed: `Before ${text} after`, inputs: 1,
  pending: false, notice: false, terminal: "Keep terminal text",
});

test("browser success requires exactly the response at the selected draft range", () => {
  assert.doesNotThrow(() => assertRoundTrip(success(), "mock"));
});

for (const [name, change] of [
  ["stale composer text", result => { result.composed = "Before selected after"; }],
  ["incorrect insertion", result => { result.composed += " duplicate"; }],
  ["duplicate input events", result => { result.inputs = 2; }],
  ["no insertion event", result => { result.inputs = 0; }],
  ["retained pending audio", result => { result.pending = true; }],
  ["error notice instead of success", result => { result.notice = true; }],
  ["terminal modification", result => { result.terminal = text; }],
  ["wrong backend", result => { result.body.provider = "azure-openai"; }],
  ["empty transcription", result => { result.body.text = ""; }],
  ["non-string transcription", result => { result.body.text = null; }],
  ["unexpected mock response", result => { result.body.text = "unrelated text"; }],
  ["null response container", result => { result.body = null; }],
  ["array response container", result => { result.body = []; }],
]) {
  test(`browser success contract rejects ${name}`, () => {
    const result = success();
    change(result);
    assert.throws(() => assertRoundTrip(result, "mock"));
  });
}
