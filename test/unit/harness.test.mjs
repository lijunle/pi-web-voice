import assert from "node:assert/strict";
import test from "node:test";
import { withTimeout, waitFor } from "../helpers/async.mjs";
import { serializeSettings } from "../helpers/host-config.mjs";
import { requestPolicy } from "../helpers/network.mjs";

const pending = () => new Promise(() => {});

test("bounded work preserves values and synchronous/asynchronous failures", async () => {
  assert.equal(await withTimeout(() => 42, "value"), 42);
  const error = new Error("fixture error");
  await assert.rejects(withTimeout(() => { throw error; }, "throw"), actual => actual === error);
  await assert.rejects(withTimeout(() => Promise.reject(error), "reject"), actual => actual === error);
});

test("a pending operation times out and a late rejection remains handled", async () => {
  let reject;
  const work = new Promise((_, fail) => { reject = fail; });
  await assert.rejects(withTimeout(() => work, "pending operation", 20), /Timed out: pending operation/);
  reject(new Error("late rejection"));
  await new Promise(resolve => setImmediate(resolve));
});

test("polling bounds a hanging condition as well as an always-false condition", async () => {
  await assert.rejects(waitFor(pending, "hung evaluation", 20), /waiting for hung evaluation/);
  await assert.rejects(waitFor(() => false, "false condition", 20), /waiting for false condition/);
});

test("polling resolves after a condition changes and propagates evaluation errors", async () => {
  let attempts = 0;
  await waitFor(() => ++attempts === 2, "second evaluation", 1000);
  assert.equal(attempts, 2);
  await assert.rejects(waitFor(() => { throw new Error("page closed"); }, "closed page"), /page closed/);
});

test("host settings use one extra quote pair to preserve literal values", () => {
  assert.equal(serializeSettings({ PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: '"literal"' }),
    'PI_VOICE_PROVIDER="mock"\nOPENAI_API_KEY=""literal""');
});

for (const [name, settings] of [
  ["missing provider", { OPENAI_API_KEY: "fixture" }],
  ["unknown provider", { PI_VOICE_PROVIDER: "constructor" }],
  ["inherited provider", Object.create({ PI_VOICE_PROVIDER: "mock" })],
  ["non-voice settings", { PI_VOICE_PROVIDER: "mock", NODE_OPTIONS: "fixture" }],
  ["non-string values", { PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: null }],
  ["multiline values", { PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: "fixture\nINJECTED=value" }],
  ["NUL values", { PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: "fixture\0" }],
]) {
  test(`host settings reject ${name} before file creation`, () => {
    assert.throws(() => serializeSettings(settings));
  });
}

const origin = "http://127.0.0.1:12345";
const transcribe = `${origin}/__voice/transcribe?session=fixture`;

test("live policy blocks early/duplicate uploads before sending and permits one deliberate POST", () => {
  const policy = requestPolicy(origin, { live: true });
  assert.equal(policy.allow("POST", transcribe), false);
  policy.permitUpload();
  assert.equal(policy.allow("POST", transcribe), true);
  assert.equal(policy.allow("POST", transcribe), false);
  assert.equal(policy.uploads, 1);
  assert.equal(policy.violations.length, 2);
  assert.throws(() => policy.permitUpload(), /exactly one upload/);
});

test("only project setup can write outside transcription and only during setup", () => {
  const policy = requestPolicy(origin);
  assert.equal(policy.allow("POST", `${origin}/api/default-cwd`), true);
  policy.finishSetup();
  assert.equal(policy.allow("POST", `${origin}/api/default-cwd`), false);
  assert.equal(policy.allow("POST", `${origin}/api/agent/new`), false);
  assert.equal(policy.allow("GET", `${origin}/api/models`), true);
  assert.equal(policy.violations.length, 2);
});

test("external writes are blocked and recorded without retaining private URLs", () => {
  const policy = requestPolicy(origin, { live: true });
  policy.permitUpload();
  assert.equal(policy.allow("POST", "https://example.invalid/__voice/transcribe?key=PRIVATE"), false);
  assert.equal(policy.allow("POST", transcribe), true, "an external request cannot consume the local permission");
  assert.equal(policy.allow("GET", "https://example.invalid/telemetry"), false);
  assert.deepEqual(policy.violations, ["unexpected application write"]);
});

test("integration allows repeated mock POSTs but rejects incorrect transcription methods", () => {
  const policy = requestPolicy(origin);
  assert.equal(policy.allow("POST", transcribe), true);
  assert.equal(policy.allow("POST", transcribe), true);
  assert.equal(policy.allow("GET", transcribe), false);
  assert.equal(policy.allow("PUT", transcribe), false);
  assert.equal(policy.uploads, 2);
});
