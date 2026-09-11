/** Real local HTTP requests, mocked speech service, metadata-only log assertions. */
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRouter } = require("../../lib/routes.cjs");
const { toneWav } = require("../../lib/doctor.cjs");
const audio = toneWav(3);
const privateText = "PRIVATE_TRANSCRIPT_do_not_log";

function config(deployment = "gpt-transcribe") {
  return {
    prefix: "/__voice",
    provider: "azure-openai",
    azureOpenAI: {
      endpoint: "https://speech.example.invalid",
      deployment,
      apiVersion: "2025-03-01-preview",
      key: "PRIVATE_API_KEY_do_not_log",
    },
    context: { maxTerms: 400, bytes: 1024, sessions: 5 },
    limits: { timeoutMs: 1000, maxBytes: 1024 * 1024 },
  };
}

async function harness(t, { settings = config(), body = { text: "" }, status = 200, error } = {}) {
  const logs = [];
  const errors = [];
  const requests = [];
  const upstreamHeaders = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  let respond = () => {
    if (error) throw error;
    return new Response(JSON.stringify(body), { status });
  };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init.body);
    upstreamHeaders.push(init.headers);
    return respond();
  });
  const server = http.createServer(createRouter(settings));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  function post(bytes = audio, query = "", headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: server.address().port,
        path: `/__voice/transcribe${query}`,
        method: "POST",
        agent: false,
        headers: { "content-type": "audio/wav", "accept-language": "zh-CN,en;q=0.8", ...headers },
      }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(2000, () => req.destroy(new Error("local request timed out")));
      req.end(bytes);
    });
  }
  return { post, logs, errors, requests, upstreamHeaders, setResponse(fn) { respond = fn; } };
}

function requestId(response) {
  const id = response.headers["x-pi-voice-request-id"];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return id;
}

test("empty responses log provider-default VAD, outcome, UTC time and a per-request ID", async (t) => {
  const h = await harness(t);
  const first = await h.post();
  const second = await h.post();
  assert.equal(first.status, 200);
  assert.equal(first.body.text, "");
  assert.equal(second.body.text, "");
  assert.notEqual(requestId(first), requestId(second));
  for (const [index, response] of [first, second].entries()) {
    assert.match(h.logs[index], /^\[pi-web-voice\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);
    assert.ok(h.logs[index].includes(`request=${requestId(response)}`));
    assert.match(h.logs[index], /audio_context=unspecified · provider=azure-openai · vad=default · result=empty/);
    assert.match(h.logs[index], /3\.0s audio · 0 terms · 0 chars · zh\/en/);
    assert.doesNotMatch(h.logs[index], /mic opened|filtered|blocked/);
    assert.equal(h.requests[index].get("chunking_strategy"), null);
    assert.match(h.logs[index], /audio_gate=signal · audio_samples=48000/);
  }
  assert.deepEqual(h.errors, []);
});

test("nonempty results log counts and microphone wait, never the transcript", async (t) => {
  const h = await harness(t, { body: { text: privateText } });
  const response = await h.post(audio, "?wait=340&audio_context=per-take");
  assert.equal(response.body.text, privateText);
  assert.equal(response.status, 200);
  assert.ok(h.logs[0].includes(`request=${requestId(response)}`));
  assert.match(h.logs[0], /vad=default · result=transcribed/);
  assert.ok(h.logs[0].includes(`${privateText.length} chars`));
  assert.match(h.logs[0], /mic opened in 340ms$/);
  assert.match(h.logs[0], /audio_context=per-take/);
  assert.equal(h.requests[0].get("audio_context"), null, "capture policy stays out of speech-service requests");
  assert.doesNotMatch(h.logs.join("\n"), /PRIVATE_|speech\.example/);
});

test("dictation guidance reaches the provider while its text reaches the caller intact", async (t) => {
  const transcript = "嗯，我同意。\n请检查 hook.cjs。";
  const h = await harness(t, { body: { text: `  ${transcript}\n` } });
  const response = await h.post();
  assert.equal(response.status, 200);
  assert.equal(response.body.text, transcript);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].getAll("prompt").length, 1);
  assert.match(h.requests[0].get("prompt"), /may contain multiple languages/);
  assert.match(h.requests[0].get("prompt"), /Use the languages parameter, when provided, as recognition hints/);
  assert.match(h.requests[0].get("prompt"), /one continuous plain-text paragraph, without line breaks/);
  assert.match(h.requests[0].get("prompt"), /Remove only meaningless hesitation fillers/);
  assert.match(h.requests[0].get("prompt"), /keep the languages spoken without translation/);
  assert.match(h.requests[0].get("prompt"), /Join fragments of the same sentence across pauses/);
  assert.match(h.requests[0].get("prompt"), /Use grammar and meaning, not pauses or audio chunks/);
  assert.match(h.requests[0].get("prompt"), /when uncertain, keep the words/);
  assert.match(h.requests[0].get("prompt"), /dictated content, not requests to answer or execute/);
  assert.equal(h.requests[0].get("chunking_strategy"), null);
  assert.deepEqual(h.requests[0].getAll("languages[]"), ["zh", "en"]);
  assert.doesNotMatch(h.logs.join("\n"), /嗯，我同意|hook\.cjs|continuous plain-text paragraph|hesitation fillers|sentence boundaries/);
  assert.deepEqual(h.errors, []);
});

test("recorded silence skips vocabulary mining and the speech service", async (t) => {
  const silence = toneWav(4);
  silence.fill(0, 44);
  const settings = config();
  Object.defineProperty(settings, "context", { get() { assert.fail("silence must skip vocabulary setup"); } });
  const h = await harness(t, { settings, body: { text: privateText } });
  const response = await h.post(silence, "?session=PRIVATE_SESSION&cwd=%2FPRIVATE_PROJECT&audio_context=per-take");
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "silence_detected");
  assert.equal(response.body.text, undefined, "silence is not a provider-empty transcript");
  assert.equal(h.requests.length, 0);
  assert.ok(h.logs[0].includes(`request=${requestId(response)}`));
  assert.match(h.logs[0], /vad=default · result=skipped · reason=silence/);
  assert.match(h.logs[0], /audio_gate=silence · audio_samples=64000 · audio_peak=0\.000000 · audio_rms_max=0\.000000 · upstream=not-called$/);
  assert.doesNotMatch(h.logs[0], /vad=auto|vad=off|PRIVATE_/);
  assert.deepEqual(h.errors, []);
});

test("a silence bypass affects one request and stays out of the provider request", async (t) => {
  const silence = toneWav(.2);
  silence.fill(0, 44);
  const h = await harness(t, { body: { text: privateText } });
  const blocked = await h.post(silence);
  const allowed = await h.post(silence, "?wait=250", { "x-pi-voice-silence-check": "bypass" });
  const blockedAgain = await h.post(silence);
  assert.deepEqual([blocked.status, allowed.status, blockedAgain.status], [422, 200, 422]);
  assert.equal(new Set([blocked, allowed, blockedAgain].map(requestId)).size, 3);
  assert.equal(allowed.body.text, privateText);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Buffer.from(await h.requests[0].get("file").arrayBuffer()), silence);
  assert.equal(h.requests[0].get("chunking_strategy"), null);
  assert.equal(h.requests[0].get("x-pi-voice-silence-check"), null);
  assert.equal(h.upstreamHeaders[0]["x-pi-voice-silence-check"], undefined);
  assert.match(h.logs[1], /audio_gate=bypass · mic opened in 250ms$/);
  assert.doesNotMatch(h.logs.join("\n"), /PRIVATE_/);
});

test("a bypassed take retains its WAV and default chunking through provider fallback", async (t) => {
  const silence = toneWav(.2);
  silence.fill(0, 44);
  const h = await harness(t);
  let attempts = 0;
  h.setResponse(() => ++attempts === 1
    ? new Response(JSON.stringify({ error: "unsupported keywords" }), { status: 400 })
    : new Response(JSON.stringify({ text: privateText })));
  const response = await h.post(silence, "", { "x-pi-voice-silence-check": "bypass" });
  assert.equal(response.status, 200);
  assert.equal(response.body.text, privateText);
  assert.equal(h.requests.length, 2, "one browser request can make a compatibility fallback");
  for (const [index, form] of h.requests.entries()) {
    assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), silence);
    assert.equal(form.get("chunking_strategy"), null);
    assert.equal(form.get("x-pi-voice-silence-check"), null);
    assert.equal(h.upstreamHeaders[index]["x-pi-voice-silence-check"], undefined);
    assert.match(form.get("prompt"), /one continuous plain-text paragraph/);
  }
  assert.match(h.logs[0], /audio_gate=bypass$/);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /structured request rejected \(400\).*vad=default$/);
  assert.doesNotMatch([...h.logs, ...h.errors].join("\n"), /PRIVATE_/);
});

test("a bypass marker preserves the zero-byte upload rejection", async (t) => {
  const h = await harness(t);
  const response = await h.post(Buffer.alloc(0), "", { "x-pi-voice-silence-check": "bypass" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "empty audio");
  assert.equal(h.requests.length, 0);
  assert.match(h.logs[0], /result=rejected · reason=empty-audio$/);
});

test("only the exact bypass header value bypasses silence detection", async (t) => {
  const silence = toneWav(.2);
  silence.fill(0, 44);
  const h = await harness(t);
  for (const value of ["", "skip", "true", "BYPASS", "bypass, bypass", "PRIVATE_MARKER", ["bypass", "bypass"]]) {
    assert.equal((await h.post(silence, "", { "x-pi-voice-silence-check": value })).status, 422);
  }
  assert.equal(h.requests.length, 0);
  assert.doesNotMatch(h.logs.join("\n"), /PRIVATE_MARKER|audio_gate=bypass/);
});

test("a quiet short signal after silence forwards the complete WAV and provider text", async (t) => {
  const wav = toneWav(4);
  wav.fill(0, 44);
  const short = toneWav(.08);
  for (let offset = 44; offset < short.length; offset += 2) {
    short.writeInt16LE(Math.round(short.readInt16LE(offset) / 32), offset);
  }
  short.copy(wav, 44 + 3 * 32000, 44);
  const transcript = "好。\nYes.";
  const h = await harness(t, { body: { text: transcript } });
  const response = await h.post(wav);
  assert.equal(response.status, 200);
  assert.equal(response.body.text, transcript);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Buffer.from(await h.requests[0].get("file").arrayBuffer()), wav);
  assert.equal(h.requests[0].get("chunking_strategy"), null);
  assert.match(h.logs[0], /audio_gate=signal · audio_samples=64000/);
});

test("unrecognized audio passes through without a guessed silence classification", async (t) => {
  const h = await harness(t, { body: { text: "normal result" } });
  const response = await h.post(Buffer.from("unrecognized audio format"));
  assert.equal(response.status, 200);
  assert.equal(response.body.text, "normal result");
  assert.equal(h.requests.length, 1);
  assert.match(h.logs[0], /audio_gate=unknown/);
});

for (const provider of ["azure-openai", "azure-speech", "openai", "mock"]) {
  test(`silence gating precedes the ${provider} adapter`, async (t) => {
    const silence = toneWav(.2);
    silence.fill(0, 44);
    const h = await harness(t, { settings: { ...config(), provider } });
    assert.equal((await h.post(silence)).status, 422);
    assert.equal(h.requests.length, 0);
    assert.match(h.logs[0], /upstream=not-called$/);
  });
}

test("a model with no VAD override is logged as default, not disabled", async (t) => {
  const h = await harness(t, { settings: config("whisper") });
  const response = await h.post();
  assert.equal(response.status, 200);
  assert.equal(h.requests[0].get("chunking_strategy"), null);
  assert.match(h.logs[0], /vad=default · result=empty/);
  assert.doesNotMatch(h.logs[0], /vad=off|vad=auto/);
});

test("an upstream error logs its status but not its private response body", async (t) => {
  const h = await harness(t, { status: 429, body: { error: privateText } });
  const response = await h.post();
  assert.equal(response.status, 502);
  assert.ok(response.body.error.includes(privateText), "the caller still gets the diagnosis");
  assert.equal(h.requests.length, 1);
  assert.ok(h.errors[0].includes(`request=${requestId(response)}`));
  assert.match(h.errors[0], /vad=default · result=error/);
  assert.match(h.errors[0], /upstream_status=429$/);
  assert.doesNotMatch(h.errors.join("\n"), /PRIVATE_|speech\.example/);
  assert.deepEqual(h.logs, []);
});

test("an upstream 422 remains a provider error, not a local silence result", async (t) => {
  const h = await harness(t, { status: 422, body: { code: "silence_detected", error: privateText } });
  const response = await h.post();
  assert.equal(response.status, 502);
  assert.equal(response.body.code, undefined);
  assert.ok(response.body.error.includes(privateText));
  assert.equal(h.requests.length, 1);
  assert.match(h.errors[0], /result=error/);
  assert.match(h.errors[0], /audio_gate=signal/);
  assert.match(h.errors[0], /upstream_status=422$/);
  assert.doesNotMatch(h.errors[0], /PRIVATE_|result=skipped|upstream=not-called/);
});

test("manual retries of the same audio log each outcome separately without exposing content", async (t) => {
  const h = await harness(t);
  let attempts = 0;
  h.setResponse(() => {
    const failed = ++attempts < 3;
    return new Response(JSON.stringify(failed ? { error: privateText } : { text: privateText }), {
      status: failed ? 503 : 200,
    });
  });
  const bytes = Buffer.concat([audio, Buffer.from("PRIVATE_AUDIO_do_not_log")]);
  const query = "?session=PRIVATE_SESSION&cwd=%2FPRIVATE_PROJECT&wait=340&audio_context=per-take";
  const responses = [];
  for (let attempt = 0; attempt < 3; attempt += 1) responses.push(await h.post(bytes, query));

  assert.deepEqual(responses.map(response => response.status), [502, 502, 200]);
  assert.equal(new Set(responses.map(requestId)).size, 3, "a retry is a new HTTP request");
  assert.equal(h.errors.length, 2);
  assert.equal(h.logs.length, 1);
  const records = [...h.errors, ...h.logs];
  for (const [index, response] of responses.entries()) {
    assert.ok(records[index].includes(`request=${requestId(response)}`));
    assert.match(records[index], /audio_context=per-take/);
    assert.deepEqual(Buffer.from(await h.requests[index].get("file").arrayBuffer()), bytes);
  }
  assert.match(h.errors[0], /result=error.*upstream_status=503$/);
  assert.match(h.errors[1], /result=error.*upstream_status=503$/);
  assert.match(h.logs[0], /result=transcribed/);
  assert.doesNotMatch(records.join("\n"), /PRIVATE_|speech\.example/);
  assert.ok(responses[0].body.error.includes(privateText), "error details still reach the browser");
  assert.equal(responses[2].body.text, privateText, "successful text still reaches the browser");
});

test("transport failures do not log an error message that could contain a URL or key", async (t) => {
  const h = await harness(t, { error: new TypeError("PRIVATE_API_KEY_do_not_log") });
  const response = await h.post();
  assert.equal(response.status, 502);
  assert.match(h.errors[0], /result=error.*upstream_status=n\/a$/);
  assert.doesNotMatch(h.errors[0], /PRIVATE_/);
});

test("primitive thrown values become caller errors with metadata-only service logs", async t => {
  const h = await harness(t);
  for (const value of ["PRIVATE_THROWN_VALUE", null, 42]) {
    h.setResponse(() => { throw value; });
    const response = await h.post();
    assert.equal(response.status, 502);
    assert.equal(response.body.error, String(value));
    assert.match(h.errors.at(-1), /result=error.*upstream_status=n\/a$/);
  }
  assert.doesNotMatch(h.errors.join("\n"), /PRIVATE_THROWN_VALUE/);
});

test("hostile thrown values still produce a retryable response and private logs", async t => {
  const h = await harness(t);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = {
    get message() { throw new Error("PRIVATE_GETTER"); },
    get status() { throw new Error("PRIVATE_STATUS"); },
    [Symbol.toPrimitive]() { throw new Error("PRIVATE_COERCION"); },
  };
  for (const error of [Object.create(null), hostile, revoked.proxy]) {
    h.setResponse(() => { throw error; });
    const response = await h.post();
    assert.equal(response.status, 502);
    assert.equal(response.body.error, "Unknown error");
    assert.match(h.errors.at(-1), /result=error.*upstream_status=n\/a$/);
  }
  assert.doesNotMatch(h.errors.join("\n"), /PRIVATE_/);
});

test("non-binary request chunks reject through the route instead of escaping stream callbacks", async t => {
  const errors = [];
  t.mock.method(console, "error", message => errors.push(message));
  t.mock.method(globalThis, "fetch", () => assert.fail("invalid audio must stay local"));
  let destroyed = false, status, body;
  const req = Object.assign(new EventEmitter(), {
    url: "/__voice/transcribe", method: "POST", headers: {},
    destroy() { destroyed = true; },
  });
  const res = {
    setHeader() {},
    writeHead(code) { status = code; },
    end(payload) { body = JSON.parse(payload); },
  };
  const handled = createRouter(config())(req, res);
  assert.doesNotThrow(() => req.emit("data", "PRIVATE_DECODED_AUDIO"));
  assert.doesNotThrow(() => req.emit("end"));
  await handled;
  assert.equal(destroyed, true);
  assert.equal(status, 502);
  assert.equal(body.error, "audio stream must emit Buffer chunks");
  assert.doesNotMatch(errors.join("\n"), /PRIVATE_DECODED_AUDIO/);
});

test("a bypass marker preserves the upload byte limit", async t => {
  const errors = [];
  t.mock.method(console, "error", message => errors.push(message));
  t.mock.method(globalThis, "fetch", () => assert.fail("oversized audio must stay local"));
  const settings = config();
  settings.limits.maxBytes = 100;
  let destroyed = false, status, body;
  const req = Object.assign(new EventEmitter(), {
    url: "/__voice/transcribe", method: "POST", headers: { "x-pi-voice-silence-check": "bypass" },
    destroy() { destroyed = true; },
  });
  const res = {
    setHeader() {}, writeHead(code) { status = code; }, end(payload) { body = JSON.parse(payload); },
  };
  const handled = createRouter(settings)(req, res);
  req.emit("data", Buffer.alloc(101));
  req.emit("end");
  await handled;
  assert.equal(destroyed, true);
  assert.equal(status, 502);
  assert.equal(body.error, "audio exceeds 100 bytes");
  assert.match(errors[0], /audio_gate=unchecked · upstream_status=n\/a$/);
});

test("a zero-byte upload is logged as rejected without calling the speech service", async (t) => {
  const h = await harness(t);
  const response = await h.post(Buffer.alloc(0), "?audio_context=per-take");
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "empty audio");
  assert.ok(h.logs[0].includes(`request=${requestId(response)}`));
  assert.match(h.logs[0], /result=rejected · reason=empty-audio$/);
  assert.match(h.logs[0], /audio_context=per-take/);
  assert.equal(h.requests.length, 0);
});

test("unrecognized capture-policy values stay unspecified and cannot inject log content", async t => {
  const h = await harness(t);
  for (const value of ["", "reused", "PER-TAKE", "PRIVATE_TOKEN\nforged-log", "per-take\u0000"]) {
    const response = await h.post(audio, `?audio_context=${encodeURIComponent(value)}`);
    assert.equal(response.status, 200);
    assert.match(h.logs.at(-1), /audio_context=unspecified/);
  }
  assert.doesNotMatch(h.logs.join("\n"), /PRIVATE_|forged-log|reused|PER-TAKE|\u0000/);
});

test("untrusted microphone wait values cannot inject text into the log", async (t) => {
  const h = await harness(t);
  for (const wait of ["-1", "Infinity", "PRIVATE_TEXT\nextra-line"]) {
    assert.equal((await h.post(audio, `?wait=${encodeURIComponent(wait)}`)).status, 200);
  }
  assert.doesNotMatch(h.logs.join("\n"), /mic opened|PRIVATE_TEXT|extra-line/);
});
