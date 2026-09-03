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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.NODE_OPTIONS;

const child = spawn(process.execPath, ["--test", join(here, "patch.test.mjs")], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
