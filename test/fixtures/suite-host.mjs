/** Lifecycle fixture for the supervisor tests; uses their local pi-web stub. */
import { readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withHost } from "../helpers/host.mjs";

const [mode, report] = process.argv.slice(2);
const root = process.env.PI_VOICE_TEST_ROOT;
function reportState(state) {
  writeFileSync(`${report}.tmp`, JSON.stringify(state));
  renameSync(`${report}.tmp`, report);
}
reportState({ root });
await withHost({ PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: '"fixture-only"' }, async origin => {
  const home = join(root, readdirSync(root).find(name => name.startsWith("pi-web-voice-host-")));
  reportState({ root, home, origin });
  if (mode === "exit") process.exit(7); // Bypass finally to exercise supervisor ownership.
  if (mode === "fail") throw new Error("Intentional fixture failure");
  if (mode === "freeze") for (;;) { /* Deliberately block graceful signal handlers. */ }
});
