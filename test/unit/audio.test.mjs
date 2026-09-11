/** Signal-gate tests use synthetic PCM and a committed synthetic speech fixture. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { analyzePcmWav } = require("../../lib/audio.cjs");
const { toneWav } = require("../../lib/doctor.cjs");

function silence(seconds = 4) {
  const wav = toneWav(seconds);
  wav.fill(0, 44);
  return wav;
}
function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
function riff(chunks) {
  const body = Buffer.concat([Buffer.from("WAVE"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
const fmt = silence(.02).subarray(20, 36);
const silentData = Buffer.alloc(640);

for (const seconds of [.02, .2, 3, 4, 600]) {
  test(`${seconds}s of supported silent PCM is measured without changing the WAV`, () => {
    const wav = silence(seconds);
    const original = Buffer.from(wav);
    assert.deepEqual(analyzePcmWav(wav), { silent: true, samples: seconds * 16000, peak: 0, maxRms: 0 });
    assert.deepEqual(wav, original);
  });
}

test("very low-level synthetic noise is quiet, not a reason to send vocabulary", () => {
  const wav = silence();
  for (let offset = 44; offset < wav.length; offset += 2) {
    wav.writeInt16LE((offset * 17 % 41) - 20, offset);
  }
  const analysis = analyzePcmWav(wav);
  assert.equal(analysis.silent, true);
  assert.ok(analysis.maxRms > 0 && analysis.maxRms < .001);
  assert.ok(analysis.peak > 0 && analysis.peak < .004);
});

test("window RMS passes a quiet short signal after a long silence", () => {
  const wav = silence(30);
  // 80 ms at roughly -54 dBFS peak, with a 30-second take diluting its average.
  const first = 29 * 16000 + 157;
  for (let i = 0; i < 1280; i++) wav.writeInt16LE(Math.round(64 * Math.sin(i / 7)), 44 + (first + i) * 2);
  const analysis = analyzePcmWav(wav);
  assert.equal(analysis.silent, false);
  assert.ok(analysis.peak < .004, "the quiet signal passes on local RMS, not peak");
  assert.ok(analysis.maxRms > .001);
});

test("a peak above the limit passes even if it is only a click", () => {
  const wav = silence();
  wav.writeInt16LE(132, 44 + 400 * 2);
  const analysis = analyzePcmWav(wav);
  assert.equal(analysis.silent, false);
  assert.ok(analysis.maxRms < .001);
  assert.ok(analysis.peak > .004);
});

test("RMS and peak boundaries are conservative and inclusive", () => {
  for (const [level, silent] of [[32, true], [33, false]]) {
    const wav = silence(.02);
    for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(level, offset);
    assert.equal(analyzePcmWav(wav).silent, silent);
  }
  for (const [level, silent] of [[131, true], [132, false]]) {
    const wav = silence(.02);
    wav.writeInt16LE(level, 44);
    assert.equal(analyzePcmWav(wav).silent, silent);
  }
});

test("both sample polarities and the last partial window contribute to the result", () => {
  for (const level of [-32768, 32767]) {
    const wav = silence(.021);
    wav.writeInt16LE(level, wav.length - 2);
    const analysis = analyzePcmWav(wav);
    assert.equal(analysis.silent, false);
    assert.equal(analysis.peak, Math.abs(level) / 32768);
    assert.ok(analysis.maxRms > .001);
  }
});

for (const divisor of [1, 16]) {
  test(`synthetic speech passes with amplitude divided by ${divisor}`, () => {
    const wav = readFileSync(new URL("../fixtures/voice-en.wav", import.meta.url));
    for (let offset = 44; offset < wav.length; offset += 2) {
      wav.writeInt16LE(Math.round(wav.readInt16LE(offset) / divisor), offset);
    }
    const original = Buffer.from(wav);
    assert.equal(analyzePcmWav(wav).silent, false);
    assert.deepEqual(wav, original);
  });
}

test("silence analysis accepts padded ancillary chunks and data before fmt", () => {
  for (const chunks of [
    [chunk("JUNK", Buffer.from("private")), chunk("fmt ", fmt), chunk("data", silentData)],
    [chunk("data", silentData), chunk("LIST", Buffer.from("notes")), chunk("fmt ", fmt)],
    [chunk("fmt ", Buffer.concat([fmt, Buffer.alloc(2)])), chunk("data", silentData)],
  ]) {
    assert.equal(analyzePcmWav(riff(chunks)).silent, true);
  }
});

for (const [name, corrupt] of [
  ["not WAV", () => Buffer.from("not an audio file")],
  ["all-zero unrecognized bytes", () => Buffer.alloc(96044)],
  ["less than a 20 ms window", () => silence(.019)],
  ["no samples", () => silence(0)],
  ["truncated file", wav => wav.subarray(0, wav.length - 1)],
  ["extra trailing bytes", wav => Buffer.concat([wav, Buffer.from("PRIVATE")])],
  ["RIFF size mismatch", wav => { wav.writeUInt32LE(0, 4); return wav; }],
  ["big-endian RIFX", wav => { wav.write("RIFX"); return wav; }],
  ["high-bit magic bytes", wav => { wav[0] |= 128; return wav; }],
  ["non-WAVE container", wav => { wav.write("xxxx", 8); return wav; }],
  ["incomplete chunk header", () => riff([Buffer.alloc(3)])],
  ["oversized chunk", wav => { wav.writeUInt32LE(0xffffffff, 16); return wav; }],
  ["short format chunk", () => riff([chunk("fmt ", Buffer.alloc(14)), chunk("data", silentData)])],
  ["missing format chunk", () => riff([chunk("data", silentData)])],
  ["missing data chunk", () => riff([chunk("fmt ", fmt), chunk("JUNK", silentData)])],
  ["duplicate format chunks", () => riff([chunk("fmt ", fmt), chunk("fmt ", fmt), chunk("data", silentData)])],
  ["multiple data chunks", () => riff([chunk("fmt ", fmt), chunk("data", silentData), chunk("data", Buffer.from([255, 127]))])],
  ["odd data length", () => riff([chunk("fmt ", fmt), chunk("data", Buffer.alloc(641))])],
  ["missing odd-chunk padding", () => riff([chunk("fmt ", fmt), chunk("data", silentData), chunk("JUNK", Buffer.from([0])).subarray(0, 9)])],
  ["excessive chunk count", () => riff([...Array.from({ length: 129 }, () => chunk("JUNK", Buffer.alloc(0))), chunk("fmt ", fmt), chunk("data", silentData)])],
  ["float encoding", wav => { wav.writeUInt16LE(3, 20); return wav; }],
  ["stereo", wav => { wav.writeUInt16LE(2, 22); return wav; }],
  ["different sample rate", wav => { wav.writeUInt32LE(48000, 24); return wav; }],
  ["wrong byte rate", wav => { wav.writeUInt32LE(0, 28); return wav; }],
  ["wrong block alignment", wav => { wav.writeUInt16LE(0, 32); return wav; }],
  ["different bit depth", wav => { wav.writeUInt16LE(8, 34); return wav; }],
]) {
  test(`${name} remains unknown, so the gate can pass it through`, () => {
    assert.equal(analyzePcmWav(corrupt(silence(.02))), null);
  });
}

test("the chunk-scan budget includes format and data chunks", () => {
  const within = [...Array.from({ length: 126 }, () => chunk("JUNK", Buffer.alloc(0))), chunk("fmt ", fmt), chunk("data", silentData)];
  assert.equal(analyzePcmWav(riff(within)).silent, true, "exactly 128 chunks are supported");
  assert.equal(analyzePcmWav(riff([chunk("JUNK", Buffer.alloc(0)), ...within])), null);
});

test("mutated RIFF containers stay bounded and leave input bytes unchanged", () => {
  const template = riff([chunk("JUNK", Buffer.alloc(3)), chunk("fmt ", fmt), chunk("data", silentData)]);
  let state = 71;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let trial = 0; trial < 1000; trial++) {
    const wav = Buffer.from(template);
    for (let count = 0, changes = 1 + next() % 4; count < changes; count++) {
      wav[12 + next() % (wav.length - 12)] = next() >>> 24;
    }
    const original = Buffer.from(wav);
    const analysis = analyzePcmWav(wav);
    if (analysis !== null) {
      assert.ok(Number.isInteger(analysis.samples) && analysis.samples >= 320);
      assert.ok(Number.isFinite(analysis.peak) && analysis.peak >= 0 && analysis.peak <= 1);
      assert.ok(Number.isFinite(analysis.maxRms) && analysis.maxRms >= 0 && analysis.maxRms <= 1);
      assert.equal(analysis.silent, analysis.maxRms <= .001 && analysis.peak <= .004);
    }
    assert.deepEqual(wav, original);
  }
});

test("bounded random bytes never throw or become known silence", () => {
  let state = 17;
  for (let size = 0; size < 256; size++) {
    const wav = Buffer.alloc(size);
    for (let i = 0; i < wav.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      wav[i] = state >>> 24;
    }
    assert.equal(analyzePcmWav(wav), null);
  }
});
