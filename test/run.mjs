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

// Browser suites remain opt-in and get the same clean environment. Otherwise
// a preloaded installed hook could inject a second script into the local fixture.
const suite = process.argv[2];
if (suite && !["e2e-edge.mjs", "e2e-retry.mjs"].includes(suite)) {
  console.error(`Unknown browser suite: ${suite}`);
  process.exit(1);
}
const tests = readdirSync(here)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => join(here, file));
const args = suite ? [join(here, suite), ...process.argv.slice(3)] : ["--test", ...tests];
const child = spawn(process.execPath, args, {
  env,
  stdio: "inherit",
});

child.on("error", error => { console.error(error.message); process.exit(1); });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
