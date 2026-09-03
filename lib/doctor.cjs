"use strict";

const fs = require("node:fs");
const { loadConfig, ENV_FILE } = require("./config.cjs");
const { transcribe, termBudget } = require("./providers.cjs");
const { collectTerms } = require("./context.cjs");

/**
 * Preflight for the configured speech backend.
 *
 *   pi-web-voice doctor [recording.wav]
 *
 * With no file it sends a one-second tone. The transcript will be empty, which
 * is expected: the point is to prove that the key, region, endpoint and model
 * name are right before you go looking for a microphone bug that isn't there.
 */

function toneWav(seconds = 1, sampleRate = 16000) {
  const samples = seconds * sampleRate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), 44 + i * 2);
  }
  return buffer;
}

function mask(value) {
  if (!value) return "(missing)";
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function describe(config) {
  switch (config.provider) {
    case "azure-speech":
      return [
        ["endpoint", config.azureSpeech.endpoint || "(missing)"],
        ["key", mask(config.azureSpeech.key)],
        ["model", config.azureSpeech.model],
        ["api-version", config.azureSpeech.apiVersion],
        ["style", config.azureSpeech.style],
      ];
    case "azure-openai":
      return [
        ["endpoint", config.azureOpenAI.endpoint || "(missing)"],
        ["key", mask(config.azureOpenAI.key)],
        ["deployment", config.azureOpenAI.deployment],
        ["api-version", config.azureOpenAI.apiVersion],
      ];
    case "openai":
      return [
        ["base url", config.openai.baseUrl],
        ["key", mask(config.openai.key)],
        ["model", config.openai.model],
      ];
    default:
      return [];
  }
}

/** Turns provider failures into the thing that is actually wrong. */
function diagnose(message) {
  if (/\b401\b|Unauthorized|Access denied/i.test(message)) {
    return "the key is wrong, or it belongs to a different resource";
  }
  if (/\b403\b/.test(message)) return "the key is valid but not allowed to call this operation";
  if (/\b404\b/.test(message)) {
    return "endpoint or deployment not found — check the resource name, and that the region offers this model";
  }
  if (/\b400\b/.test(message)) {
    return "the request was rejected — usually a model name the region does not serve, or an unsupported audio format";
  }
  if (/\b429\b/.test(message)) return "rate limited — the credentials work, try again shortly";
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return "cannot reach the endpoint — check the URL and your network";
  if (/aborted/i.test(message)) return "timed out";
  return "";
}

async function doctor(argv) {
  const config = loadConfig();
  const file = argv[0];

  console.log(`provider   ${config.provider}`);
  console.log(`env file   ${config.envFile || `(none at ${ENV_FILE})`}`);
  for (const [label, value] of describe(config)) {
    console.log(`${label.padEnd(11)}${value}`);
  }

  const cwd = process.cwd();
  const limit = Math.min(config.context.maxTerms, termBudget(config.provider));
  const terms = collectTerms("", cwd, config, limit);
  console.log(`context    scope=${config.context.scope}, ${terms.length} terms`);
  if (terms.length > 0) console.log(`           ${terms.slice(0, 12).join(", ")}${terms.length > 12 ? " …" : ""}`);

  const audio = file ? fs.readFileSync(file) : toneWav();
  console.log(`audio      ${file ?? "generated 1s tone"} (${audio.length} bytes)`);

  const started = Date.now();
  try {
    const text = await transcribe(audio, config, terms);
    const ms = Date.now() - started;
    console.log(`\nok         ${ms} ms`);
    console.log(`transcript ${text ? JSON.stringify(text) : "(empty)"}`);
    if (!text && !file) {
      console.log("\nAn empty transcript from a tone is expected. Credentials, region and\nmodel are working. Pass a real recording to check accuracy.");
    }
    return 0;
  } catch (error) {
    const message = error.message ?? String(error);
    console.error(`\nfailed     ${Date.now() - started} ms`);
    console.error(`           ${message.slice(0, 400)}`);
    const hint = diagnose(message);
    if (hint) console.error(`\nlikely     ${hint}`);
    return 1;
  }
}

module.exports = { doctor, toneWav };
