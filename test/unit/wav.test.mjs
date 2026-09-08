import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { assertRecordingWav } from "../helpers/round-trip.mjs";

const require = createRequire(import.meta.url);
const { toneWav } = require("../../lib/doctor.cjs");

test("the browser recording contract accepts a valid non-silent PCM fixture", () => {
  assert.doesNotThrow(() => assertRecordingWav(toneWav()));
});

for (const [name, corrupt] of [
  ["empty body", () => Buffer.alloc(0)],
  ["incomplete sample", audio => audio.subarray(0, audio.length - 1)],
  ["RIFF size mismatch", audio => { audio.writeUInt32LE(0, 4); return audio; }],
  ["non-WAV container", audio => { audio.write("xxxx", 8); return audio; }],
  ["invalid format chunk size", audio => { audio.writeUInt32LE(0, 16); return audio; }],
  ["non-PCM encoding", audio => { audio.writeUInt16LE(3, 20); return audio; }],
  ["stereo samples", audio => { audio.writeUInt16LE(2, 22); return audio; }],
  ["wrong sample rate", audio => { audio.writeUInt32LE(48000, 24); return audio; }],
  ["wrong byte rate", audio => { audio.writeUInt32LE(0, 28); return audio; }],
  ["wrong block alignment", audio => { audio.writeUInt16LE(0, 32); return audio; }],
  ["wrong bit depth", audio => { audio.writeUInt16LE(8, 34); return audio; }],
  ["invalid data chunk", audio => { audio.write("xxxx", 36); return audio; }],
  ["data size mismatch", audio => { audio.writeUInt32LE(0, 40); return audio; }],
  ["all-zero capture", audio => { audio.fill(0, 44); return audio; }],
]) {
  test(`the browser recording contract rejects ${name}`, () => {
    assert.throws(() => assertRecordingWav(corrupt(toneWav())));
  });
}
