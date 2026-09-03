"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Configuration comes from two places, environment wins:
 *
 *   1. A JSON file: $PI_VOICE_CONFIG, else ~/.pi/agent/voice.json (optional).
 *   2. Environment variables (see README).
 */

const DEFAULT_CONFIG_PATHS = [
  process.env.PI_VOICE_CONFIG,
  path.join(os.homedir(), ".pi", "agent", "voice.json"),
].filter(Boolean);

function readConfigFile() {
  for (const file of DEFAULT_CONFIG_PATHS) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch (error) {
      console.error(`[pi-web-voice] ignoring ${file}: ${error.message}`);
    }
  }
  return {};
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function list(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function text(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Accepts a bare resource name or a full https URL, returns a base URL. */
function azureEndpoint(value, suffix) {
  const raw = text(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return `https://${raw}.${suffix}`;
}

function loadConfig() {
  const file = readConfigFile();
  const env = process.env;

  const provider = text(
    env.PI_VOICE_PROVIDER,
    file.provider,
    // Infer from whichever credentials are present.
    env.AZURE_SPEECH_KEY || file.azureSpeech?.key ? "azure-speech" : "",
    env.AZURE_OPENAI_API_KEY || file.azureOpenAI?.key ? "azure-openai" : "",
    env.OPENAI_API_KEY || file.openai?.key ? "openai" : "",
    "mock",
  );

  return {
    enabled: bool(env.PI_VOICE_ENABLED ?? file.enabled, true),
    prefix: text(env.PI_VOICE_PREFIX, file.prefix, "/__voice").replace(/\/+$/, ""),
    provider,

    // Recognition hints shared by every provider.
    // `terms` are pinned extras; the useful vocabulary is mined per request
    // from the conversation itself (see lib/context.cjs).
    terms: list(env.PI_VOICE_TERMS || file.terms),
    locale: text(env.PI_VOICE_LOCALE, file.locale),

    context: {
      // "session" = current conversation, "project" = plus recent sessions in
      // the same working directory, "off" = pinned terms only.
      scope: text(env.PI_VOICE_CONTEXT, file.context?.scope, "session"),
      maxTerms: Number(env.PI_VOICE_MAX_TERMS || file.context?.maxTerms || 400),
      bytes: Number(env.PI_VOICE_CONTEXT_BYTES || file.context?.bytes || 256 * 1024),
      sessions: Number(env.PI_VOICE_PROJECT_SESSIONS || file.context?.sessions || 5),
    },

    // Browser behaviour.
    ui: {
      autoSend: bool(env.PI_VOICE_AUTO_SEND ?? file.ui?.autoSend, false),
      mode: text(env.PI_VOICE_MODE, file.ui?.mode, "toggle"), // "toggle" | "hold"
      shortcut: text(env.PI_VOICE_SHORTCUT, file.ui?.shortcut, "mod+shift+v"),
      mediaSession: bool(env.PI_VOICE_MEDIA_SESSION ?? file.ui?.mediaSession, true),
      maxSeconds: Number(env.PI_VOICE_MAX_SECONDS || file.ui?.maxSeconds || 180),
      language: text(env.PI_VOICE_UI_LANGUAGE, file.ui?.language), // "" = follow browser
    },

    // Azure AI Speech — fast transcription, incl. MAI-Transcribe-2.
    azureSpeech: {
      endpoint: azureEndpoint(
        env.AZURE_SPEECH_ENDPOINT || env.AZURE_SPEECH_RESOURCE || file.azureSpeech?.endpoint,
        "cognitiveservices.azure.com",
      ),
      key: text(env.AZURE_SPEECH_KEY, file.azureSpeech?.key),
      model: text(env.PI_VOICE_SPEECH_MODEL, file.azureSpeech?.model, "MAI-Transcribe-2"),
      apiVersion: text(env.PI_VOICE_SPEECH_API_VERSION, file.azureSpeech?.apiVersion, "2025-10-15"),
      style: text(env.PI_VOICE_SPEECH_STYLE, file.azureSpeech?.style, "clean"), // clean | verbatim
    },

    // Azure OpenAI — gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper.
    azureOpenAI: {
      endpoint: azureEndpoint(
        env.AZURE_OPENAI_ENDPOINT || file.azureOpenAI?.endpoint,
        "openai.azure.com",
      ),
      key: text(env.AZURE_OPENAI_API_KEY, file.azureOpenAI?.key),
      deployment: text(env.PI_VOICE_DEPLOYMENT, file.azureOpenAI?.deployment, "gpt-4o-transcribe"),
      apiVersion: text(env.PI_VOICE_OPENAI_API_VERSION, file.azureOpenAI?.apiVersion, "2024-10-21"),
    },

    // Anything speaking the OpenAI audio API: OpenAI, Groq, local whisper.cpp.
    openai: {
      baseUrl: text(env.PI_VOICE_OPENAI_BASE_URL, file.openai?.baseUrl, "https://api.openai.com/v1"),
      key: text(env.PI_VOICE_OPENAI_API_KEY, env.OPENAI_API_KEY, file.openai?.key),
      model: text(env.PI_VOICE_OPENAI_MODEL, file.openai?.model, "whisper-1"),
    },

    limits: {
      maxBytes: Number(env.PI_VOICE_MAX_BYTES || file.maxBytes || 25 * 1024 * 1024),
      timeoutMs: Number(env.PI_VOICE_TIMEOUT_MS || file.timeoutMs || 120_000),
    },
  };
}

module.exports = { loadConfig };
