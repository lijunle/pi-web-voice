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
const path = require("node:path");

const hook = path.join(__dirname, "..", "hook.cjs");
const quoted = hook.includes(" ") ? `"${hook}"` : hook;

const env = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${quoted}`,
};

const command = process.env.PI_VOICE_TARGET || "pi-web";
const child = spawn(command, process.argv.slice(2), { env, stdio: "inherit", shell: process.platform === "win32" });

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error(
      `[pi-web-voice] cannot find "${command}". Install it with: npm i -g @agegr/pi-web`,
    );
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
