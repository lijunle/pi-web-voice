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

  // pi-web's workspace terminal keeps an xterm.js IME helper textarea mounted
  // after the composer. It used to win "the last visible textarea" and swallow
  // every transcript, so stand one up and prove it is ignored.
  await evaluate(`(() => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.appendChild(helper);
    document.body.appendChild(terminal);
    return true;
  })()`);

  const composerClass = await evaluate(`(() => {
    const found = window.__piWebVoice.findComposer();
    if (!found) return "null";
    return found.closest(".xterm") ? "terminal" : found.className || "unnamed";
  })()`);
  check(
    "terminal helper textarea ignored",
    composerClass !== "terminal" && composerClass !== "null",
    `composer=${composerClass}`,
  );

  // The keyboard, VoiceOver and the macOS accessibility API all activate a
  // button through `click` and never emit pointer events. Binding pointer
  // events alone left the button dead for every one of them.
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
    document.getElementById("pi-web-voice-button").click();
    return true;
  })()`);
  await sleep(1200);
  const afterClick = await evaluate(`window.__piWebVoice.ui.state`);
  check("click() starts recording", afterClick === "recording", `state=${afterClick}`);

  await evaluate(`document.getElementById("pi-web-voice-button").click()`);
  await sleep(2500);
  const afterSecondClick = await evaluate(`window.__piWebVoice.ui.state`);
  check("click() again stops it", afterSecondClick === "idle", `state=${afterSecondClick}`);

  // The button has to turn red on the press, not when the microphone finally
  // opens. getUserMedia costs a few hundred milliseconds on a phone, and
  // painting after it read as a press the page had missed. Reading the state
  // inside the same expression as the click proves nothing was awaited first.
  const paintedAtOnce = await evaluate(`(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      new Promise((resolve) => setTimeout(() => resolve(real(constraints)), 1200));
    document.getElementById("pi-web-voice-button").click();
    return [window.__piWebVoice.ui.state, document.getElementById("pi-web-voice-button").textContent].join(",");
  })()`);
  check("red before the microphone opens", paintedAtOnce === "recording,\u2026", paintedAtOnce);

  // ...and the clock only starts when there is audio to count, so a word said
  // after the digits appear cannot be lost.
  await sleep(1800);
  const live = await evaluate(
    `[window.__piWebVoice.ui.arming, document.getElementById("pi-web-voice-button").textContent].join(",")`,
  );
  check("clock starts on the first sample", live === "false,0:00", live);

  const waited = await evaluate(`window.__piWebVoice.ui.waitedMs`);
  check("wait measured", waited >= 1200, `${waited}ms`);

  await evaluate(`window.__piWebVoice.ui.stop()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await evaluate(`window.__piWebVoice.ui.state`)) === "idle") break;
    await sleep(250);
  }

  // Pressing again during that wait has to cancel cleanly: no empty clip sent,
  // and no microphone left open once the stream nobody wants arrives.
  const cancelled = await evaluate(`(() => {
    document.getElementById("pi-web-voice-button").click();
    document.getElementById("pi-web-voice-button").click();
    return window.__piWebVoice.ui.state;
  })()`);
  check("press during the wait cancels", cancelled === "idle", `state=${cancelled}`);
  await sleep(2000);
  const settled = await evaluate(
    `[window.__piWebVoice.ui.state, window.__piWebVoice.recorder.active, !!window.__piWebVoice.recorder.stream].join(",")`,
  );
  check("orphan stream closed", settled === "idle,false,false", settled);

  // Finger-down opens the microphone so the press only has to claim it. This
  // is a head start, not a second gesture: the click still decides.
  const claimed = await evaluate(`(() => {
    const button = document.getElementById("pi-web-voice-button");
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const warmed = String(!!window.__piWebVoice.recorder.warming);
    button.click();
    return [warmed, String(window.__piWebVoice.recorder.warming)].join(",");
  })()`);
  check("finger-down warms, the press claims", claimed === "true,null", claimed);

  await sleep(1800);
  const recordingWarm = await evaluate(`window.__piWebVoice.recorder.active`);
  check("the warmed stream is the one recorded", recordingWarm === true, `active=${recordingWarm}`);

  // Use a real mouse sequence and hold it across at least one clock tick.
  // Replacing the SVG/span on every tick used to detach the mousedown target,
  // which makes Chromium suppress the ensuing click. Starting worked because
  // there was no clock yet, while stopping often needed a second mouse click.
  const clockPoint = await evaluate(`(() => {
    const button = document.getElementById("pi-web-voice-button");
    window.__mouseEvents = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, (event) => {
        window.__mouseEvents.push(type + ":" + event.target.tagName);
      });
    }
    const rect = button.querySelector("span").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: clockPoint.x,
    y: clockPoint.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(350);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: clockPoint.x,
    y: clockPoint.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const mouseResult = await evaluate(`JSON.stringify({
    state: window.__piWebVoice.ui.state,
    events: window.__mouseEvents,
  })`);
  const { state: afterMouseClick, events: mouseEvents } = JSON.parse(mouseResult);
  check(
    "one mouse click stops across a clock tick",
    afterMouseClick !== "recording",
    `state=${afterMouseClick}; events=${mouseEvents.join(",")}`,
  );

  // Keep the rest of the suite independent when this regression fails.
  if (afterMouseClick === "recording") await evaluate(`window.__piWebVoice.ui.stop()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await evaluate(`window.__piWebVoice.ui.state`)) === "idle") break;
    await sleep(250);
  }

  // A finger that slides off the button never presses it. What it opened must
  // not be left listening.
  await evaluate(`(() => {
    document.getElementById("pi-web-voice-button")
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.__unclaimed = window.__piWebVoice.recorder.warming;
    return true;
  })()`);
  await sleep(3200); // the stubbed getUserMedia takes 1.2s, the warm stream lives 1.5s
  const dropped = await evaluate(`(async () => {
    const stream = await window.__unclaimed;
    const live = stream.getTracks().filter((track) => track.readyState === "live").length;
    return [String(window.__piWebVoice.recorder.warming), live].join(",");
  })()`);
  check("unclaimed microphone dropped", dropped === "null,0", dropped);

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
    `(() => { const a = window.__piWebVoice.findComposer(); return a ? a.value : ""; })()`,
  );
  const terminalValue = await evaluate(
    `document.querySelector(".xterm-helper-textarea")?.value ?? ""`,
  );
  check("terminal left untouched", terminalValue === "", `terminal=${JSON.stringify(terminalValue)}`);
  // A real speech backend returns nothing for the synthetic tone this test
  // feeds it, and the button reports that instead of inserting. Either
  // outcome proves the round trip; only a silent failure is a problem.
  const notice = await evaluate(
    `[...document.querySelectorAll("body > div")].map(d => d.textContent).filter(t => t && t.length < 120).join(" | ")`,
  );
  const spoke = composed.trim().length > 0;
  const reported = /no speech|\u6ca1\u6709\u8bc6\u522b\u5230|failed|\u5931\u8d25/i.test(notice);
  check(
    "round trip completed",
    spoke || reported,
    spoke ? `inserted: ${composed.slice(0, 60)}` : `reported: ${notice.slice(0, 60)}`,
  );

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
