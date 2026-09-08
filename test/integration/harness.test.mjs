import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import test from "node:test";
import { serializeSettings } from "../helpers/host-config.mjs";
import { withHost } from "../helpers/host.mjs";
import { runSuite } from "../helpers/suite.mjs";
import { waitFor } from "../helpers/async.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lifecycle = fileURLToPath(new URL("../fixtures/suite-host.mjs", import.meta.url));
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-voice-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("temporary voice settings round-trip quotes literally through the real private loader", t => {
  const home = temp(t);
  const file = join(home, ".pi/agent/voice.env");
  mkdirSync(dirname(file), { recursive: true });
  const key = '"literal $NOT_EXPANDED \\n # value"';
  writeFileSync(file, serializeSettings({ PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: key }), { mode: 0o600 });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const output = execFileSync(process.execPath, ["-e", `
    const {loadConfig}=require('./lib/config.cjs');
    console.log(JSON.stringify({key:loadConfig().openai.key, exported:process.env.OPENAI_API_KEY ?? null}));
  `], { cwd: root, env: { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { key, exported: null });
});

test("invalid host configuration leaves no temporary credential directory", async t => {
  const parent = temp(t);
  const previous = process.env.PI_VOICE_TEST_ROOT;
  process.env.PI_VOICE_TEST_ROOT = parent;
  try {
    await assert.rejects(withHost({ PI_VOICE_PROVIDER: "mock", OPENAI_API_KEY: "fixture\nINVALID=value" },
      () => assert.fail("invalid configuration must not start a host")), /one line/);
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    if (previous === undefined) delete process.env.PI_VOICE_TEST_ROOT;
    else process.env.PI_VOICE_TEST_ROOT = previous;
  }
});

test("native discovery cannot authorize the live entry point or read its provider configuration", t => {
  const home = temp(t);
  const entry = fileURLToPath(new URL("../e2e/speech.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, ["--test", entry], {
    env: { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, PI_VOICE_PROVIDER: "azure-openai" },
    encoding: "utf8", stdio: "pipe", timeout: 5000,
  }), error => {
    // No credentials are configured. Authorization must fail before the provider
    // validation that would otherwise ask for a key or launch the host/browser.
    const output = `${error.stdout}${error.stderr}`;
    assert.match(output, /Live E2E requires explicit authorization/);
    assert.doesNotMatch(output, /configure AZURE_OPENAI_ENDPOINT|Live E2E · provider=/);
    return true;
  });
});

function portIsClosed(origin) {
  return new Promise(resolve => {
    const socket = net.connect(Number(new URL(origin).port), "127.0.0.1");
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(true); });
  });
}

// POSIX process groups are checked directly here. Windows uses bounded taskkill;
// its platform-specific termination behavior needs a Windows validation run.
for (const mode of ["success", "fail", "exit", "freeze", "abort", "missing-host"]) {
  test(`suite supervision cleans host processes and private files after ${mode}`, { skip: process.platform === "win32", timeout: 15_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-voice-harness-"));
    const report = join(dir, "report.json");
    const stubReport = join(dir, "stub.json");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    if (mode !== "missing-host") writeFileSync(join(bin, "pi-web"), `#!/usr/bin/env node
      const http=require('node:http'),fs=require('node:fs');
      const port=Number(process.argv[process.argv.indexOf('-p')+1]);
      ${["freeze", "abort", "exit"].includes(mode) ? 'process.on("SIGTERM",()=>{});' : ''}
      http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><head></head><body>Fixture</body></html>');}).listen(port,'127.0.0.1',()=>{
        fs.writeFileSync(${JSON.stringify(stubReport)},JSON.stringify({pid:process.pid}));
      });
    `, { mode: 0o700 });
    // Cleanup also contains a regression failure: kill only the exact fixture PID.
    t.after(async () => {
      try {
        const state = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : {};
        if (state.origin && existsSync(stubReport) && !await portIsClosed(state.origin)) {
          const { pid } = JSON.parse(readFileSync(stubReport, "utf8"));
          try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    const controller = new AbortController();
    const args = [lifecycle, report];
    const suite = runSuite([args[0], mode === "abort" ? "freeze" : mode, args[1]], {
      env: { PATH: mode === "missing-host" ? bin : `${bin}:${process.env.PATH}` },
      stdio: "ignore", timeoutMs: mode === "freeze" ? 4000 : 10_000, graceMs: 100,
      signal: controller.signal,
    });
    suite.catch(() => {});
    if (mode === "abort") {
      await waitFor(() => existsSync(report) && !!JSON.parse(readFileSync(report, "utf8")).origin, "frozen fixture readiness", 5000);
      controller.abort();
    }
    if (mode === "success") await suite;
    else await assert.rejects(suite, mode === "freeze" ? /Suite timeout/ : mode === "abort" ? /Suite interrupted/ : /Suite fails/);
    const state = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(existsSync(state.root), false, "supervisor removes all private host files");
    if (state.origin) await waitFor(() => portIsClosed(state.origin), "host socket release", 2000);
    else assert.equal(mode, "missing-host", "other scenarios reach the ready host before failing");
  });
}
