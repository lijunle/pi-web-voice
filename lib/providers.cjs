"use strict";

/**
 * Speech-to-text backends. Every provider receives raw audio bytes plus the
 * shared hints (phrase list / prompt, locale) and returns plain text.
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
  return new Error(`${response.status} ${response.statusText} ${body}`.trim());
}

function audioBlob(audio) {
  return new Blob([audio], { type: "audio/wav" });
}

/**
 * Azure AI Speech — fast transcription, including MAI-Transcribe-2.
 * Phrase list gives real decode-time keyword biasing, and leaving `locales`
 * unset keeps automatic language identification and code switching on.
 */
async function azureSpeech(audio, config) {
  const { endpoint, key, model, apiVersion, style } = config.azureSpeech;
  if (!endpoint || !key) throw new Error("azure-speech needs AZURE_SPEECH_ENDPOINT and AZURE_SPEECH_KEY");

  const definition = {
    enhancedMode: { enabled: true, model, modelOptions: { transcribeStyle: style } },
  };
  if (config.terms.length > 0) definition.phraseList = { phrases: config.terms.slice(0, 500) };
  if (config.locale) definition.locales = [config.locale];

  const form = new FormData();
  form.append("audio", audioBlob(audio), "clip.wav");
  form.append("definition", JSON.stringify(definition));

  const url = `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(apiVersion)}`;
  const response = await withTimeout(config.limits.timeoutMs, (signal) =>
    fetch(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key }, body: form, signal }),
  );
  if (!response.ok) throw await readError(response);

  const result = await response.json();
  return (result.combinedPhrases ?? []).map((phrase) => phrase.text).join(" ").trim();
}

/** Azure OpenAI: gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper. */
async function azureOpenAI(audio, config) {
  const { endpoint, key, deployment, apiVersion } = config.azureOpenAI;
  if (!endpoint || !key) throw new Error("azure-openai needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY");

  const form = new FormData();
  form.append("file", audioBlob(audio), "clip.wav");
  form.append("response_format", "json");
  if (config.terms.length > 0) form.append("prompt", config.terms.join(", "));
  if (config.locale) form.append("language", config.locale);

  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`;
  const response = await withTimeout(config.limits.timeoutMs, (signal) =>
    fetch(url, { method: "POST", headers: { "api-key": key }, body: form, signal }),
  );
  if (!response.ok) throw await readError(response);

  return String((await response.json()).text ?? "").trim();
}

/** OpenAI, Groq, or any server exposing /audio/transcriptions. */
async function openAICompatible(audio, config) {
  const { baseUrl, key, model } = config.openai;
  if (!baseUrl) throw new Error("openai needs PI_VOICE_OPENAI_BASE_URL");

  const form = new FormData();
  form.append("file", audioBlob(audio), "clip.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (config.terms.length > 0) form.append("prompt", config.terms.join(", "));
  if (config.locale) form.append("language", config.locale);

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
async function mock(audio) {
  const seconds = Math.max(1, Math.round(audio.length / (16000 * 2)));
  return `[pi-web-voice mock] received ${audio.length} bytes (~${seconds}s of audio)`;
}

const PROVIDERS = {
  "azure-speech": azureSpeech,
  "azure-openai": azureOpenAI,
  openai: openAICompatible,
  mock,
};

async function transcribe(audio, config) {
  const provider = PROVIDERS[config.provider];
  if (!provider) throw new Error(`unknown provider: ${config.provider}`);
  return provider(audio, config);
}

module.exports = { transcribe, PROVIDERS };
