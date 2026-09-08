import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin", "pi-web-voice.js");

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "pi-web-voice-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, "agent") };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (/^(?:PI_VOICE_|AZURE_SPEECH_|AZURE_OPENAI_)/.test(key) || key === "OPENAI_API_KEY") delete env[key];
  }
  return { home, env, file: path.join(home, ".pi", "agent", "voice.env") };
}

function run(args, env) {
  return execFileSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
}

test("CLI help and hook-path work directly from CommonJS source", t => {
  const { env } = fixture(t);
  assert.equal(run([cli, "hook-path"], env).trim(), path.join(root, "hook.cjs"));
  assert.match(run([cli, "--help"], env), /pi-web-voice init/);
  assert.match(run([cli, "-h"], env), /pi-web-voice doctor/);
});

test("CLI init creates a private template and preserves existing configuration", t => {
  const { env, file } = fixture(t);
  assert.match(run([cli, "init"], env), /Created/);
  const template = readFileSync(file, "utf8");
  assert.match(template, /^#AZURE_OPENAI_API_KEY=$/m);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, "PI_VOICE_PROVIDER=mock\n");
  assert.match(run([cli, "init"], env), /already exists/);
  assert.equal(readFileSync(file, "utf8"), "PI_VOICE_PROVIDER=mock\n");
  assert.match(run([cli, "doctor"], env), /provider\s+mock/);
});

test("configuration keeps file credentials private and preserves environment precedence", t => {
  const { env, file } = fixture(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# fixture\nexport AZURE_SPEECH_KEY="file-only-key"\nAZURE_SPEECH_ENDPOINT=my-resource\n', { mode: 0o600 });
  const script = `
    const fs = require('node:fs');
    const { loadConfig, ENV_FILE } = require('./lib/config.cjs');
    const first = loadConfig();
    fs.writeFileSync(ENV_FILE, 'AZURE_SPEECH_KEY=changed-file-key\\n');
    const second = loadConfig();
    console.log(JSON.stringify({
      provider: first.provider, key: first.azureSpeech.key, endpoint: first.azureSpeech.endpoint,
      cachedKey: second.azureSpeech.key, exported: process.env.AZURE_SPEECH_KEY ?? null
    }));
  `;
  const result = JSON.parse(run(["-e", script], env));
  assert.deepEqual(result, {
    provider: "azure-speech", key: "file-only-key", endpoint: "https://my-resource.cognitiveservices.azure.com",
    cachedKey: "file-only-key", exported: null,
  });
  const override = JSON.parse(run(["-e", script], { ...env, AZURE_SPEECH_KEY: "exported-key", PI_VOICE_PROVIDER: "mock" }));
  assert.equal(override.provider, "mock");
  assert.equal(override.key, "exported-key");
  const empty = JSON.parse(run(["-e", script], { ...env, AZURE_SPEECH_KEY: "" }));
  assert.equal(empty.key, "");
  assert.equal(empty.provider, "mock");
});
