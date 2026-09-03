"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Configuration is environment-only, and deliberately small. Everything that
 * has one sensible answer is a constant below rather than a knob.
 *
 * Credentials pick the backend on their own: set the Azure Speech pair and you
 * are on MAI-Transcribe-2. PI_VOICE_PROVIDER only exists to break a tie, or to
 * force `mock` while testing.
 *
 * Keys live in ~/.pi/agent/voice.env, beside pi's own configuration. Anything
 * already exported takes precedence, which is also how you override one for a
 * single run.
 */

const ENV_FILE = path.join(os.homedir(), ".pi", "agent", "voice.env");

let loadedEnvFile = null;

function loadEnvFile() {
  if (loadedEnvFile !== null) return loadedEnvFile;
  loadedEnvFile = "";
  if (!fs.existsSync(ENV_FILE)) return loadedEnvFile;

  try {
    // Node applies the same rule as --env-file: the real environment wins.
    process.loadEnvFile(ENV_FILE);
    loadedEnvFile = ENV_FILE;

    const mode = fs.statSync(ENV_FILE).mode & 0o077;
    if (mode !== 0 && process.platform !== "win32") {
      console.warn(`[pi-web-voice] ${ENV_FILE} is readable by others; chmod 600 it`);
    }
  } catch (error) {
    console.error(`[pi-web-voice] cannot read ${ENV_FILE}: ${error.message}`);
  }
  return loadedEnvFile;
}

// Not worth configuring: one correct value each.
const PREFIX = "/__voice";
const SPEECH_MODEL = "MAI-Transcribe-2";
const SPEECH_API_VERSION = "2025-10-15";
const SPEECH_STYLE = "clean"; // dictation wants the fillers gone
const OPENAI_API_VERSION = "2024-10-21";
const MAX_TERMS = 400; // further capped per provider
const CONTEXT_BYTES = 256 * 1024; // read from the end of each session file
const PROJECT_SESSIONS = 5; // past sessions consulted alongside the current one
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

function text(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function list(value) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Accepts a bare resource name, a resource URL, or a full endpoint URL. */
function azureEndpoint(value, suffix) {
  const raw = text(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return `https://${raw}.${suffix}`;
}

function loadConfig() {
  const envFile = loadEnvFile();
  const env = process.env;

  const provider = text(
    env.PI_VOICE_PROVIDER,
    env.AZURE_SPEECH_KEY ? "azure-speech" : "",
    env.AZURE_OPENAI_API_KEY ? "azure-openai" : "",
    env.OPENAI_API_KEY ? "openai" : "",
    "mock",
  );

  return {
    prefix: PREFIX,
    provider,
    envFile,

    // The vocabulary sent with each request is mined from the conversation you
    // are in, plus that project's recent ones; see lib/context.cjs.
    context: {
      maxTerms: MAX_TERMS,
      bytes: CONTEXT_BYTES,
      sessions: PROJECT_SESSIONS,
    },

    // Azure AI Speech fast transcription — MAI-Transcribe-2.
    azureSpeech: {
      endpoint: azureEndpoint(env.AZURE_SPEECH_ENDPOINT, "cognitiveservices.azure.com"),
      key: text(env.AZURE_SPEECH_KEY),
      model: SPEECH_MODEL,
      apiVersion: SPEECH_API_VERSION,
      style: SPEECH_STYLE,
    },

    // Azure OpenAI — gpt-transcribe, gpt-4o-transcribe, whisper.
    // The endpoint may be a bare resource name, a resource URL, or the full
    // transcriptions URL copied out of the portal. Azure has shipped several
    // shapes of this path, so a complete URL is taken at its word.
    azureOpenAI: {
      endpoint: azureEndpoint(env.AZURE_OPENAI_ENDPOINT, "openai.azure.com"),
      key: text(env.AZURE_OPENAI_API_KEY),
      deployment: text(env.PI_VOICE_DEPLOYMENT, "gpt-transcribe"),
      apiVersion: OPENAI_API_VERSION,
    },

    // Anything speaking the OpenAI audio API: OpenAI, Groq, local whisper.cpp.
    openai: {
      baseUrl: text(env.PI_VOICE_OPENAI_BASE_URL, "https://api.openai.com/v1"),
      key: text(env.OPENAI_API_KEY),
      model: text(env.PI_VOICE_OPENAI_MODEL, "whisper-1"),
    },

    limits: { maxBytes: MAX_UPLOAD_BYTES, timeoutMs: TIMEOUT_MS },
  };
}

module.exports = { loadConfig, ENV_FILE };
