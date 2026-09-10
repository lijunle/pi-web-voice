/** Real local HTTP requests, mocked speech service, metadata-only log assertions. */
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRouter } = require("../../lib/routes.cjs");
const audio = Buffer.alloc(44 + 3 * 16000 * 2);
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
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  let respond = () => {
    if (error) throw error;
    return new Response(JSON.stringify(body), { status });
  };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init.body);
    return respond();
  });
  const server = http.createServer(createRouter(settings));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  function post(bytes = audio, query = "") {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: server.address().port,
        path: `/__voice/transcribe${query}`,
        method: "POST",
        agent: false,
        headers: { "content-type": "audio/wav", "accept-language": "zh-CN,en;q=0.8" },
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
  return { post, logs, errors, requests, setResponse(fn) { respond = fn; } };
}

function requestId(response) {
  const id = response.headers["x-pi-voice-request-id"];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return id;
}

test("empty responses log requested VAD, outcome, UTC time and a per-request ID", async (t) => {
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
    assert.match(h.logs[index], /audio_context=unspecified · provider=azure-openai · vad=auto · result=empty/);
    assert.match(h.logs[index], /3\.0s audio · 0 terms · 0 chars · zh\/en/);
    assert.doesNotMatch(h.logs[index], /mic opened|filtered|blocked/);
    assert.equal(h.requests[index].get("chunking_strategy"), "auto");
  }
  assert.deepEqual(h.errors, []);
});

test("nonempty results log counts and microphone wait, never the transcript", async (t) => {
  const h = await harness(t, { body: { text: privateText } });
  const response = await h.post(audio, "?wait=340&audio_context=per-take");
  assert.equal(response.body.text, privateText);
  assert.equal(response.status, 200);
  assert.ok(h.logs[0].includes(`request=${requestId(response)}`));
  assert.match(h.logs[0], /vad=auto · result=transcribed/);
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
  assert.equal(h.requests[0].get("chunking_strategy"), "auto");
  assert.deepEqual(h.requests[0].getAll("languages[]"), ["zh", "en"]);
  assert.doesNotMatch(h.logs.join("\n"), /嗯，我同意|hook\.cjs|continuous plain-text paragraph|hesitation fillers|sentence boundaries/);
  assert.deepEqual(h.errors, []);
});

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
  assert.match(h.errors[0], /vad=auto · result=error/);
  assert.match(h.errors[0], /upstream_status=429$/);
  assert.doesNotMatch(h.errors.join("\n"), /PRIVATE_|speech\.example/);
  assert.deepEqual(h.logs, []);
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
