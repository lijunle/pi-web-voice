#!/usr/bin/env node
"use strict";

/**
 * Convenience launcher: starts pi-web with the voice hook preloaded.
 *
 *   pi-web-voice            # same as `pi-web`
 *   pi-web-voice -p 8080    # arguments are passed straight through
 *
 * Equivalent to setting NODE_OPTIONS yourself; this just spares you the path.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const hook = path.join(__dirname, "..", "hook.cjs");

// `pi-web-voice doctor [file.wav]` checks the speech backend and exits.
if (args[0] === "doctor") {
  const { doctor } = require("../lib/doctor.cjs");
  doctor(args.slice(1)).then((code) => {
    // Setting the code rather than calling process.exit lets the HTTP
    // connection finish closing. Forcing an exit mid-teardown trips a libuv
    // assertion on Windows: !(handle->flags & UV_HANDLE_CLOSING).
    process.exitCode = code;
    // Keep-alive sockets can still hold the loop open for a few seconds after
    // the answer is in hand. This timer does not itself keep the process
    // alive, and by the time it fires nothing is mid-close.
    setTimeout(() => process.exit(code), 750).unref();
  });
  return;
}

// `pi-web-voice hook-path` prints the absolute path to the hook, so a service
// definition can be written without knowing where npm put the package.
if (args[0] === "hook-path") {
  console.log(hook);
  return;
}

// `pi-web-voice init` creates the key file, which is all a new machine needs
// beyond installing the package.
if (args[0] === "init") {
  const { ENV_FILE } = require("../lib/config.cjs");
  if (fs.existsSync(ENV_FILE)) {
    console.log(`${ENV_FILE} already exists, leaving it alone.`);
  } else {
    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    fs.writeFileSync(
      ENV_FILE,
      `# pi-web-voice keys. Anything exported in your shell overrides these.

# Azure AI Speech — MAI-Transcribe-2. Regions: eastus, northeurope,
# southeastasia, westus, westus2.
#AZURE_SPEECH_ENDPOINT=https://my-resource.cognitiveservices.azure.com
#AZURE_SPEECH_KEY=

# Azure OpenAI — gpt-transcribe. Paste the full transcriptions URL from the
# portal; it is used verbatim, api-version and all.
#AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-03-01-preview
#AZURE_OPENAI_API_KEY=
#PI_VOICE_DEPLOYMENT=gpt-transcribe

# OpenAI, Groq, or a local whisper server.
#PI_VOICE_OPENAI_BASE_URL=https://api.groq.com/openai/v1
#OPENAI_API_KEY=
#PI_VOICE_OPENAI_MODEL=whisper-large-v3
`,
      { mode: 0o600 },
    );
    console.log(`Created ${ENV_FILE} (0600). Uncomment one backend and add its key.`);
  }
  console.log(`Then check it with:  pi-web-voice doctor`);
  return;
}

if (args[0] === "--help" || args[0] === "-h") {
  console.log(`pi-web-voice — voice input for pi-web

  pi-web-voice [pi-web args]   start pi-web with the microphone button
  pi-web-voice init            create ~/.pi/agent/voice.env
  pi-web-voice doctor [f.wav]  check the speech backend
  pi-web-voice hook-path       print the --require path for a service file

Home: ${os.homedir()}/.pi/agent/voice.env`);
  return;
}

const quoted = hook.includes(" ") ? `"${hook}"` : hook;

const env = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${quoted}`,
};

const child = spawn("pi-web", args, { env, stdio: "inherit", shell: process.platform === "win32" });

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error("[pi-web-voice] cannot find \"pi-web\". Install it with: npm i -g @agegr/pi-web");
    process.exit(127);
  }
  console.error(`[pi-web-voice] ${error.message}`);
  process.exit(1);
});

const forward = (signal) => child.kill(signal);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
