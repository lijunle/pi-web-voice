/** Request-shape regressions. Fetch is mocked; no credentials or live API calls. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { transcribe, vadMode, termBudget } = require("../../lib/providers.cjs");
const audio = Buffer.alloc(6444);
const terms = ["CLI", "retry_safe", "implementation.md"];
const languages = ["zh", "en"];

function azureConfig(deployment = "gpt-transcribe", endpoint = "https://speech.example.invalid") {
  return {
    provider: "azure-openai",
    azureOpenAI: {
      endpoint,
      deployment,
      apiVersion: "2025-03-01-preview",
      key: "test-only-key",
    },
    limits: { timeoutMs: 1000 },
  };
}

test("unknown providers and inherited property names stay outside the backend registry", async () => {
  for (const provider of ["unknown", "toString", "constructor", "__proto__"]) {
    assert.equal(termBudget(provider), 50);
    await assert.rejects(transcribe(audio, { provider }), /unknown provider/);
  }
});

for (const body of [null, [], "text", 42]) {
  test(`OpenAI-style transcription rejects a non-object response: ${JSON.stringify(body)}`, async t => {
    capture(t, [{ body }]);
    await assert.rejects(transcribe(audio, azureConfig()), /must be a JSON object/);
  });
}

test("OpenAI-style object responses preserve missing and non-string text normalization", async t => {
  capture(t, [{ body: {} }, { body: { text: 42 } }]);
  assert.equal(await transcribe(audio, azureConfig()), "");
  assert.equal(await transcribe(audio, azureConfig()), "42");
});

test("Azure Speech checks phrase containers and preserves text normalization", async t => {
  const config = {
    provider: "azure-speech",
    azureSpeech: { endpoint: "https://speech.example.invalid", key: "test-only-key", model: "MAI-Transcribe-2", apiVersion: "2025-10-15", style: "clean" },
    limits: { timeoutMs: 1000 },
  };
  capture(t, [
    { body: null }, { body: { combinedPhrases: {} } }, { body: { combinedPhrases: [null] } },
    { body: {} }, { body: { combinedPhrases: [{ text: "hello" }, { text: 42 }] } },
  ]);
  for (const message of [/JSON object/, /must be an array/, /phrase must be a JSON object/]) {
    await assert.rejects(transcribe(audio, config), message);
  }
  assert.equal(await transcribe(audio, config), "");
  assert.equal(await transcribe(audio, config), "hello 42");
});

function capture(t, replies) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const reply = replies[calls.length];
    assert.ok(reply, "unexpected extra request");
    calls.push({ url, form: init.body });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

for (const v1 of [false, true]) {
  test(`gpt-transcribe requests automatic VAD on the ${v1 ? "v1" : "deployment"} route`, async (t) => {
    const config = azureConfig();
    if (v1) {
      config.azureOpenAI.endpoint =
        "https://speech.example.invalid/openai/v1/audio/transcriptions?api-version=preview";
    }
    const calls = capture(t, [{ body: { text: "", languages: [] } }]);
    const text = await transcribe(audio, config, terms, languages);
    assert.equal(text, "", "a no-speech response must stay empty");
    assert.equal(calls.length, 1);
    const { url, form } = calls[0];
    assert.equal(
      new URL(url).pathname,
      v1 ? "/openai/v1/audio/transcriptions" : "/openai/deployments/gpt-transcribe/audio/transcriptions",
    );
    assert.equal(form.get("chunking_strategy"), "auto");
    assert.equal(form.get("chunking_strategy"), vadMode(config));
    assert.equal(form.get("chunking_strategy[type]"), null);
    assert.equal(form.get("response_format"), "json");
    assert.equal(form.get("model"), v1 ? "gpt-transcribe" : null);
    assert.deepEqual(form.getAll("keywords[]"), terms);
    assert.deepEqual(form.getAll("languages[]"), languages);
    assert.equal(form.get("file").size, audio.length);
    assert.equal(form.get("file").type, "audio/wav");
  });
}

test("VAD remains enabled when there is no conversation vocabulary", async (t) => {
  const calls = capture(t, [{ body: { text: "" } }]);
  assert.equal(await transcribe(audio, azureConfig(), [], languages), "");
  assert.equal(calls[0].form.get("chunking_strategy"), "auto");
  assert.deepEqual(calls[0].form.getAll("keywords[]"), []);
});

test("VAD reporting and requests agree when the endpoint identifies the model", async (t) => {
  const config = azureConfig(
    "alias",
    "https://speech.example.invalid/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-03-01-preview",
  );
  const calls = capture(t, [{ body: { text: "" } }]);
  await transcribe(audio, config, terms, languages);
  assert.equal(vadMode(config), "auto");
  assert.equal(calls[0].form.get("chunking_strategy"), vadMode(config));
});

test("other providers report defaults without claiming to disable their own VAD", () => {
  for (const provider of ["azure-speech", "openai", "mock"]) {
    assert.equal(vadMode({ provider }), "default");
  }
  assert.equal(vadMode(azureConfig("gpt-4o-transcribe")), "default");
});

test("a speech response still returns its transcript unchanged apart from whitespace", async (t) => {
  capture(t, [{ body: { text: "  好。现在开始测试语音识别。 \n" } }]);
  assert.equal(
    await transcribe(audio, azureConfig(), terms, languages),
    "好。现在开始测试语音识别。",
  );
});

test("the keyword-to-prompt retry retains automatic VAD", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = capture(t, [
    { status: 400, body: { error: "keywords unsupported" } },
    { body: { text: "" } },
  ]);
  assert.equal(await transcribe(audio, azureConfig(), terms, languages), "");
  assert.equal(calls.length, 2);
  for (const { form } of calls) assert.equal(form.get("chunking_strategy"), "auto");
  assert.deepEqual(calls[0].form.getAll("keywords[]"), terms);
  assert.deepEqual(calls[1].form.getAll("keywords[]"), []);
  assert.match(calls[1].form.get("prompt"), /retry_safe/);
});

test("a service rejecting VAD cannot silently downgrade to an ungated request", async (t) => {
  t.mock.method(console, "error", () => {});
  const rejection = { status: 400, body: { error: "chunking_strategy unsupported" } };
  const calls = capture(t, [rejection, rejection]);
  await assert.rejects(
    transcribe(audio, azureConfig(), terms, languages),
    /chunking_strategy unsupported/,
  );
  assert.equal(calls.length, 2);
  for (const { form } of calls) assert.equal(form.get("chunking_strategy"), "auto");
});

test("other Azure model branches keep their existing request shape", async (t) => {
  const calls = capture(t, [{ body: { text: "ok" } }, { body: { text: "ok" } }]);
  for (const deployment of ["gpt-4o-transcribe", "whisper"]) {
    assert.equal(await transcribe(audio, azureConfig(deployment), terms, languages), "ok");
  }
  for (const { form } of calls) {
    assert.equal(form.get("chunking_strategy"), null);
    assert.deepEqual(form.getAll("keywords[]"), []);
    assert.match(form.get("prompt"), /retry_safe/);
  }
});

test("OpenAI-compatible servers are not given Azure-specific VAD options", async (t) => {
  const calls = capture(t, [{ body: { text: "ok" } }]);
  const config = {
    provider: "openai",
    openai: { baseUrl: "https://speech.example.invalid/v1", model: "whisper-1", key: "" },
    limits: { timeoutMs: 1000 },
  };
  assert.equal(await transcribe(audio, config, terms, languages), "ok");
  assert.equal(calls[0].form.get("chunking_strategy"), null);
  assert.equal(calls[0].form.get("model"), "whisper-1");
});
