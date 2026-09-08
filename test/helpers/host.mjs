/** Own a loopback pi-web host without personal sessions, extensions, or agent keys. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { withTimeout } from "./async.mjs";
import { serializeSettings } from "./host-config.mjs";
import { terminateTree } from "./suite.mjs";

const cli = fileURLToPath(new URL("../../bin/pi-web-voice.js", import.meta.url));

export async function withHost(settings, run) {
  // Validate before creating files. The outer suite owns the parent directory so
  // it can remove this home even if this process requires a forced termination.
  const config = serializeSettings(settings);
  const supervised = Boolean(process.env.PI_VOICE_TEST_ROOT);
  const home = mkdtempSync(join(process.env.PI_VOICE_TEST_ROOT || tmpdir(), "pi-web-voice-host-"));
  const controller = new AbortController();
  let child, outcome, work, closing;
  const close = () => closing ??= (async () => {
    controller.abort(new Error("Isolated host closes"));
    try {
      if (child?.pid) {
        if (supervised) {
          // Keep host descendants in the supervisor's suite group. The CLI
          // forwards graceful signals; the supervisor owns forced tree cleanup.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await withTimeout(() => outcome, "isolated host shutdown", 1500);
        } else await terminateTree(child);
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  })();
  const interrupted = () => { void close().finally(() => process.exit(1)); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const configDir = join(home, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "voice.env"), config, { mode: 0o600 });
    // Credentials stay in the private file, outside the browser/agent environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i.test(key)));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"),
      NEXT_TELEMETRY_DISABLED: "1", PI_WEB_SKIP_VERSION_CHECK: "1",
    });
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address();
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [cli, "-H", "127.0.0.1", "-p", String(port), "--no-open"], {
      cwd: home, env, stdio: ["ignore", "inherit", "inherit"], detached: !supervised && process.platform !== "win32",
    });
    outcome = new Promise(resolve => {
      child.once("error", error => resolve({ error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const exited = outcome.then(({ code, signal }) => {
      const error = new Error(`Isolated pi-web exits (${signal ?? code ?? "launch error"})`);
      controller.abort(error);
      throw error;
    });
    work = (async () => {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const response = await fetch(`${origin}/__voice/health`, { signal: AbortSignal.timeout(1000) });
          assert.ok(response.ok);
          assert.deepEqual(await response.json(), { ok: true, provider: settings.PI_VOICE_PROVIDER });
          ready = true;
          break;
        } catch { await sleep(100); }
      }
      controller.signal.throwIfAborted();
      assert.ok(ready, "isolated pi-web becomes ready within 30 seconds; install pi-web on PATH");
      // Health bypasses the app; check that Next also serves injected HTML.
      const response = await fetch(origin, { signal: AbortSignal.timeout(15_000) });
      assert.ok(response.ok, "pi-web serves its application");
      assert.match(await response.text(), /\/__voice\/inject\.js/, "the checkout hook injects into pi-web HTML");
      controller.signal.throwIfAborted();
      console.log(`Isolated pi-web ready · provider=${settings.PI_VOICE_PROVIDER}`);
      await run(origin, controller.signal);
    })();
    await Promise.race([work, exited]);
  } finally {
    try {
      await close();
      // An unexpected host exit aborts the callback's browser. Give its finally
      // block time to run; the outer supervisor still owns the hard deadline.
      if (work) await withTimeout(() => work.catch(() => {}), "host callback cleanup", 3000).catch(() => {});
    } finally {
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
    }
  }
}
