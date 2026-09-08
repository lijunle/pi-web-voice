/** Run explicit test tiers against the checkout, with inherited hooks removed. */
import { runSuite } from "./helpers/suite.mjs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL("./", import.meta.url));
const requested = process.argv.slice(2);
if (requested.length > 1 || (requested.length && !["unit", "integration", "e2e"].includes(requested[0]))) {
  console.error("Usage: node test/run.mjs [unit|integration|e2e]");
  process.exit(1);
}
const tiers = requested.length ? requested : ["unit", "integration"];
const env = { ...process.env };
delete env.NODE_OPTIONS;
// Ordinary checks never select a live provider, even in a credentialed shell.
if (!tiers.includes("e2e")) env.PI_VOICE_PROVIDER = "mock";
// Native `node --test` discovers every .mjs under test/, not only *.test.mjs.
// Authorize paid calls only for the explicitly selected tier, never by inheritance.
env.PI_VOICE_TEST_LIVE = tiers.includes("e2e") ? "1" : "0";

const run = (args, timeoutMs) => runSuite(args, { env, timeoutMs });

try {
  for (const tier of tiers) {
    console.log(`\n=== ${tier} ===`);
    if (tier === "e2e") {
      await run([join(here, "e2e/speech.mjs")], 180_000);
      continue;
    }
    const tests = readdirSync(join(here, tier)).filter(file => file.endsWith(".test.mjs")).sort();
    if (!tests.length) throw new Error(`No ${tier} tests found`);
    await run(["--test", ...tests.map(file => join(here, tier, file))]);
    if (tier === "integration") {
      await run([join(here, "integration/harness-browser.mjs")]);
      await run([join(here, "integration/browser.mjs")]);
      await run([join(here, "integration/pi-web.mjs")]);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
