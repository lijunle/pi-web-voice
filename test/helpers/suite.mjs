/** Supervise a suite's process group and private files outside the suite itself. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function terminateTree(child, graceMs = 1000) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // taskkill owns the descendant walk on Windows and has its own hard bound.
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", timeout: 5000 });
    if (result.error) throw new Error("Cannot terminate the test process tree");
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
      throw new Error("Test process tree termination fails");
    }
    return;
  }
  const signal = name => {
    try { process.kill(-child.pid, name); return true; }
    catch (error) { if (error.code !== "ESRCH") throw error; return false; }
  };
  // Address the group even if the leader exits first and leaves a server behind.
  if (!signal("SIGTERM")) return;
  await sleep(graceMs);
  signal("SIGKILL");
}

export async function runSuite(args, { env = process.env, timeoutMs = 120_000, graceMs = 1000, stdio = "inherit", signal } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-voice-suite-"));
  const childEnv = { ...env, PI_VOICE_TEST_ROOT: root };
  delete childEnv.NODE_OPTIONS;
  let child, timer, interrupt;
  const interrupted = new Promise((_, reject) => { interrupt = () => reject(new Error("Suite interrupted")); });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  signal?.addEventListener("abort", interrupt, { once: true });
  try {
    signal?.throwIfAborted();
    child = spawn(process.execPath, args, {
      env: childEnv, stdio, detached: process.platform !== "win32",
    });
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal || code !== 0) reject(new Error(`Suite fails (${signal ?? code}): ${args.join(" ")}`));
        else resolve();
      });
    });
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Suite timeout: ${args.join(" ")}`)), timeoutMs);
    });
    await Promise.race([completed, expired, interrupted]);
  } finally {
    clearTimeout(timer);
    try {
      await terminateTree(child, graceMs);
    } finally {
      // The supervisor retains cleanup ownership when a suite is forcibly killed.
      try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        signal?.removeEventListener("abort", interrupt);
      }
    }
  }
}
