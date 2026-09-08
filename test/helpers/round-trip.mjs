/** Shared success contract; a notice or stale draft never substitutes for insertion. */
import assert from "node:assert/strict";
import { withTimeout } from "./async.mjs";

export async function readResponseBody(response, timeoutMs = 15_000) {
  const text = await withTimeout(async () => {
    try { return await response.text(); }
    catch { throw new Error("Cannot read transcription response body"); }
  }, "transcription response body", timeoutMs);
  try { return JSON.parse(text); }
  catch { throw new Error("Transcription response contains invalid JSON"); }
}

export function assertRecordingWav(audio) {
  assert.ok(Buffer.isBuffer(audio) && audio.length > 44 && (audio.length - 44) % 2 === 0,
    "recording uploads complete PCM samples, not an empty WAV header");
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.readUInt32LE(4), audio.length - 8, "RIFF size matches the upload");
  assert.equal(audio.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(audio.readUInt32LE(16), 16, "PCM format chunk size");
  assert.equal(audio.readUInt16LE(20), 1, "integer PCM encoding");
  assert.equal(audio.readUInt16LE(22), 1, "mono");
  assert.equal(audio.readUInt32LE(24), 16000, "16 kHz");
  assert.equal(audio.readUInt32LE(28), 32000, "PCM byte rate");
  assert.equal(audio.readUInt16LE(32), 2, "PCM block alignment");
  assert.equal(audio.readUInt16LE(34), 16, "16-bit PCM");
  assert.equal(audio.toString("ascii", 36, 40), "data");
  assert.equal(audio.readUInt32LE(40), audio.length - 44, "data size matches the upload");
  assert.ok(audio.subarray(44).some(byte => byte !== 0), "the synthetic tone/speech contains non-silent samples");
}

export function assertRoundTrip(result, provider) {
  assert.ok(result.body && typeof result.body === "object" && !Array.isArray(result.body), "transcription response is a JSON object");
  assert.equal(result.body.provider, provider, "the selected backend handles the request");
  assert.equal(typeof result.body.text, "string", "the response supplies text");
  assert.ok(result.body.text.trim(), "speech produces nonempty text; a notice is not a successful insertion");
  if (provider === "mock") assert.match(result.body.text, /^\[pi-web-voice mock\] received \d+ bytes/);
  assert.ok(result.composed === `Before ${result.body.text} after`, "the response replaces only the selected draft text");
  assert.equal(result.inputs, 1, "exactly one insertion event");
  assert.equal(result.pending, false, "pending audio clears");
  assert.equal(result.notice, false, "success leaves no error notice");
  assert.equal(result.terminal, "Keep terminal text", "workspace terminal stays untouched");
}
