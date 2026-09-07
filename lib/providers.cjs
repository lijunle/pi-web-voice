"use strict";

/**
 * Speech-to-text backends. Each one declares how many vocabulary entries it
 * can usefully take, and receives the terms the caller mined for this request.
 *
 * The browser always uploads 16 kHz mono PCM WAV, which every backend accepts,
 * so no server-side ffmpeg or format negotiation is needed.
 */

async function withTimeout(ms, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readError(response) {
  const body = await response.text().catch(() => "");
  const error = new Error(`${response.status} ${response.statusText} ${body}`.trim());
  // Keep the status separate so request logs need not copy an upstream body,
  // which may echo vocabulary, audio-derived text or other private content.
  error.status = response.status;
  return error;
}

function audioBlob(audio) {
  return new Blob([audio], { type: "audio/wav" });
}

/**
 * Credentials travel in HTTP headers, which only carry bytes. A key that is
 * still the placeholder, or that picked up a stray quote or newline, would
 * otherwise surface as "Cannot convert argument to a ByteString", which says
 * nothing about what to go and fix.
 */
function checkKey(key, variable) {
  if (!key) throw new Error(`${variable} is not set in ~/.pi/agent/voice.env`);
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new Error(
      `${variable} contains characters that cannot go in an HTTP header — ` +
        `is the placeholder still in ~/.pi/agent/voice.env?`,
    );
  }
}

/**
 * Azure AI Speech — fast transcription, including MAI-Transcribe-2.
 * Phrase list gives real decode-time keyword biasing, and leaving `locales`
 * unset keeps automatic language identification and code switching on.
 */
async function azureSpeech(audio, config, terms) {
  const { endpoint, key, model, apiVersion, style } = config.azureSpeech;
  if (!endpoint) throw new Error("azure-speech needs AZURE_SPEECH_ENDPOINT");
  checkKey(key, "AZURE_SPEECH_KEY");

  const url = `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(apiVersion)}`;

  const send = async (phrases) => {
    const definition = {
      enhancedMode: { enabled: true, model, modelOptions: { transcribeStyle: style } },
    };
    if (phrases.length > 0) definition.phraseList = { phrases };
    // `locales` is deliberately never set: leaving it off keeps automatic
    // language identification and mid-sentence code switching enabled.

    const form = new FormData();
    form.append("audio", audioBlob(audio), "clip.wav");
    form.append("definition", JSON.stringify(definition));

    return withTimeout(config.limits.timeoutMs, (signal) =>
      fetch(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key }, body: form, signal }),
    );
  };

  let response = await send(terms);

  // A rejected vocabulary must never cost someone their recording: drop the
  // phrase list and transcribe anyway, slightly less accurately.
  if (response.status === 400 && terms.length > 0) {
    console.error("[pi-web-voice] phrase list rejected, retrying without it");
    response = await send([]);
  }

  if (!response.ok) throw await readError(response);

  const result = await response.json();
  return (result.combinedPhrases ?? []).map((phrase) => phrase.text).join(" ").trim();
}

/**
 * Whisper-style models read a free-form `prompt`. Whisper only keeps the final
 * 224 tokens of it, so the list goes last and stays short.
 */
function vocabularyPrompt(terms) {
  if (terms.length === 0) return "";
  let prompt = "";
  for (const term of terms) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length > 700) break;
    prompt = next;
  }
  return `Terms that may appear: ${prompt}.`;
}

function azureUsesKeywords(config) {
  const { endpoint, deployment } = config.azureOpenAI;
  return /gpt-transcribe/i.test(endpoint) || /gpt-transcribe/i.test(deployment);
}

/** The VAD setting we request, not a report of the service's detection result. */
function vadMode(config) {
  return config.provider === "azure-openai" && azureUsesKeywords(config) ? "auto" : "default";
}

/**
 * Azure OpenAI.
 *
 * `AZURE_OPENAI_ENDPOINT` may be a resource name, a resource URL, or the whole
 * transcriptions URL copied from the portal — Azure has shipped the classic
 * `/openai/deployments/<name>/audio/transcriptions?api-version=...` path and
 * the newer `/openai/v1/audio/transcriptions?api-version=preview` surface, and
 * which one a resource serves is not worth guessing.
 *
 * `gpt-transcribe` accepts structured `keywords[]` and `languages[]`, which
 * suits a mined vocabulary far better than stuffing it into a free-form
 * prompt. Older models get the prompt instead. If the service rejects the
 * structured fields, the request is retried with the prompt so a recording is
 * never lost to a parameter mismatch.
 */
async function azureOpenAI(audio, config, terms, languages) {
  const { endpoint, key, deployment, apiVersion } = config.azureOpenAI;
  if (!endpoint) throw new Error("azure-openai needs AZURE_OPENAI_ENDPOINT");
  checkKey(key, "AZURE_OPENAI_API_KEY");

  const explicit = /\/audio\/transcriptions/.test(endpoint);
  const url = explicit
    ? endpoint
    : `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`;
  const needsModel = /\/openai\/v1\//.test(url);
  const structured = azureUsesKeywords(config);
  const vad = vadMode(config);

  const send = async (withKeywords) => {
    const form = new FormData();
    form.append("file", audioBlob(audio), "clip.wav");
    form.append("response_format", "json");
    // gpt-transcribe can generate vocabulary-biased text from silence. Its
    // file endpoint accepts automatic VAD as a scalar form field. Keep it on
    // even when retrying without keywords; that retry still needs the gate.
    if (vad === "auto") form.append("chunking_strategy", vad);
    if (needsModel) form.append("model", deployment);

    if (withKeywords) {
      for (const term of terms) form.append("keywords[]", term);
      for (const language of languages) form.append("languages[]", language);
    } else {
      const prompt = vocabularyPrompt(terms);
      if (prompt) form.append("prompt", prompt);
    }

    return withTimeout(config.limits.timeoutMs, (signal) =>
      fetch(url, { method: "POST", headers: { "api-key": key }, body: form, signal }),
    );
  };

  let response = await send(structured);
  if (!response.ok && response.status === 400 && structured) {
    console.error(
      `[pi-web-voice] structured request rejected (400), retrying with a prompt · vad=${vad}`,
    );
    response = await send(false);
  }
  if (!response.ok) throw await readError(response);

  return String((await response.json()).text ?? "").trim();
}

/** OpenAI, Groq, or any server exposing /audio/transcriptions. */
async function openAICompatible(audio, config, terms) {
  const { baseUrl, key, model } = config.openai;
  if (!baseUrl) throw new Error("openai needs PI_VOICE_OPENAI_BASE_URL");
  if (key) checkKey(key, "OPENAI_API_KEY");

  const form = new FormData();
  form.append("file", audioBlob(audio), "clip.wav");
  form.append("model", model);
  form.append("response_format", "json");
  const prompt = vocabularyPrompt(terms);
  if (prompt) form.append("prompt", prompt);

  const response = await withTimeout(config.limits.timeoutMs, (signal) =>
    fetch(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: form,
      signal,
    }),
  );
  if (!response.ok) throw await readError(response);

  return String((await response.json()).text ?? "").trim();
}

/** No credentials required. Used to verify the plumbing end to end. */
async function mock(audio, config, terms, languages) {
  const seconds = Math.max(1, Math.round(audio.length / (16000 * 2)));
  const vocabulary = terms.length > 0 ? ` · ${terms.length} terms: ${terms.slice(0, 8).join(", ")}` : "";
  return `[pi-web-voice mock] received ${audio.length} bytes (~${seconds}s of audio) · ${languages.join("/")}${vocabulary}`;
}

// How many vocabulary entries each backend can usefully absorb.
// MAI-Transcribe rejects a phrase list longer than 50 outright, and
// whisper-style prompts are bounded by their token budget.
const TERM_BUDGET = {
  "azure-speech": 50,
  "azure-openai": 60,
  openai: 60,
  mock: 50,
};

const PROVIDERS = {
  "azure-speech": azureSpeech,
  "azure-openai": azureOpenAI,
  openai: openAICompatible,
  mock,
};

function termBudget(provider) {
  return TERM_BUDGET[provider] ?? 50;
}

async function transcribe(audio, config, terms = [], languages = ["en"]) {
  const provider = PROVIDERS[config.provider];
  if (!provider) throw new Error(`unknown provider: ${config.provider}`);
  return provider(audio, config, terms, languages);
}

module.exports = { transcribe, termBudget, vadMode, PROVIDERS };
