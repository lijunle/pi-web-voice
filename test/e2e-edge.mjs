/**
 * End-to-end check against a real pi-web instance and a real browser.
 *
 *   node test/e2e-edge.mjs [http://127.0.0.1:31141]
 *
 * Edge is started headless with a synthetic microphone, so the whole path is
 * exercised: button mount → getUserMedia → WAV encode → POST /transcribe →
 * text inserted into the composer.
 *
 * Requires Microsoft Edge (or set BROWSER to any Chromium binary).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] || "http://127.0.0.1:31141";
const browser =
  process.env.BROWSER || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), "pi-web-voice-"));

const child = spawn(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--use-fake-ui-for-media-stream", // auto-accept the permission prompt
    "--use-fake-device-for-media-stream", // synthetic microphone
    "--autoplay-policy=no-user-gesture-required",
    target,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  const wanted = new URL(target).host;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(
        (entry) => entry.type === "page" && entry.webSocketDebuggerUrl && entry.url.includes(wanted),
      );
      if (page) return page;
    } catch {
      /* browser not up yet */
    }
    await sleep(250);
  }
  throw new Error("Edge did not expose a debugging target");
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    ready,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const page = await pageTarget();
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const evaluate = async (expression, timeoutMs = 15000) => {
    const call = cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const expiry = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${expression.slice(0, 40)}`)), timeoutMs),
    );
    const { result, exceptionDetails } = await Promise.race([call, expiry]);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "eval failed");
    return result.value;
  };

  // The browser may have raced the server; make sure the app really loaded.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await evaluate(`location.href`)).startsWith("chrome-error")) break;
    await cdp.send("Page.navigate", { url: target });
    await sleep(1000);
  }

  // Let the SPA settle and the observer mount the button.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(`!!document.getElementById("pi-web-voice-button")`)) break;
    await sleep(500);
  }

  check("script injected", await evaluate(`!!window.__piWebVoice`));
  check("button mounted", await evaluate(`!!document.getElementById("pi-web-voice-button")`));
  check("secure context", await evaluate(`window.isSecureContext`));

  // Headless browsers have no audio input device, so feed the recorder a
  // synthetic stream instead. Everything after capture is the real code path:
  // downsampling, WAV encoding, upload, response handling, DOM insertion.
  await evaluate(`(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const destination = ctx.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
    return true;
  })()`);

  await evaluate(`window.__piWebVoice.ui.start()`);
  await sleep(1500);
  check("recording state", (await evaluate(`window.__piWebVoice.ui.state`)) === "recording");

  const captured = await evaluate(`window.__piWebVoice.recorder.chunks.reduce((n, c) => n + c.length, 0)`);
  check("audio captured", captured > 0, `${captured} samples`);

  await evaluate(`window.__piWebVoice.ui.stop()`);
  await sleep(2500);

  const state = await evaluate(`window.__piWebVoice.ui.state`);
  check("returned to idle", state === "idle", `state=${state}`);

  const composed = await evaluate(
    `(() => { const a=[...document.querySelectorAll("textarea")].filter(t=>t.offsetParent); return a.length?a[a.length-1].value:""; })()`,
  );
  check("transcript inserted into composer", composed.includes("pi-web-voice mock"), composed.slice(0, 80));

  cdp.close();
} finally {
  child.kill();
  // Edge needs a moment to release its profile directory.
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* a leftover temp profile is harmless */
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
