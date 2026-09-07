/**
 * Runs the test suite in a child process with NODE_OPTIONS cleared.
 *
 * The hook is normally loaded through NODE_OPTIONS, so a shell started from
 * inside a hooked pi-web inherits it. That would preload the hook into the
 * test runner itself, `install()` would find the prototype already patched and
 * do nothing, and the tests would silently exercise the ambient installation
 * instead of their own. Stripping the variable keeps the suite hermetic.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.NODE_OPTIONS;

// Only unit-test files: never pick up the opt-in browser/live-service suite.
const tests = readdirSync(here)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => join(here, file));
const child = spawn(process.execPath, ["--test", ...tests], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
