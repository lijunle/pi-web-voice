/** Shared browser-side setup and observations for mock integration and live E2E. */
import assert from "node:assert/strict";
import { waitFor, withTimeout } from "./async.mjs";
import { requestPolicy } from "./network.mjs";
import { assertRecordingWav, readResponseBody } from "./round-trip.mjs";

export async function guardNetwork(page, origin, options) {
  const traffic = requestPolicy(origin, options);
  await page.route("**/*", route => {
    const request = route.request();
    return traffic.allow(request.method(), request.url()) ? route.continue() : route.abort();
  });
  return traffic;
}

export async function mountVoice(page, origin, options) {
  const traffic = await guardNetwork(page, origin, options);
  // Install before application code, so an accidental startup acquisition cannot
  // touch a physical device or disappear before synthetic audio instrumentation.
  await page.addInitScript(() => {
    window.__unexpectedMicOpens = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      window.__unexpectedMicOpens++;
      throw new Error("The test permits synthetic audio only");
    };
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  // A fresh pi-web home starts at project selection, not at a chat composer.
  // Let the real UI create its default directory inside the temporary HOME.
  await page.getByRole("button", { name: "Select project…", exact: true }).click();
  await page.getByRole("button", { name: "Use default directory", exact: true }).click();
  await page.locator("#pi-web-voice-button").waitFor({ state: "visible", timeout: 30_000 });
  traffic.finishSetup();
  assert.ok(await page.evaluate(() => window.isSecureContext && !!window.__piWebVoice));
  assert.equal(await page.evaluate(() => window.__unexpectedMicOpens), 0, "startup never opens a microphone");
  await page.evaluate(() => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    helper.value = "Keep terminal text";
    terminal.appendChild(helper);
    document.body.appendChild(terminal);
    const area = window.__piWebVoice.findComposer();
    if (!area || area.closest(".xterm")) throw new Error("Voice selects the workspace terminal instead of the composer");
    window.__voiceInputs = 0;
    area.addEventListener("input", () => window.__voiceInputs++);
  });
  return traffic;
}

export async function installAudio(page, wavBase64 = null) {
  await page.evaluate(base64 => {
    const Native = window.AudioContext;
    const state = window.__audioTest = { contexts: [], sources: [], openings: [], calls: 0, peak: 0, deferred: false };
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); state.contexts.push(this); }
    };
    navigator.mediaDevices.getUserMedia = () => {
      state.calls++;
      return new Promise((resolve, reject) => {
        const open = async () => {
          const context = new Native();
          try {
            const destination = context.createMediaStreamDestination();
            const source = base64 ? context.createBufferSource() : context.createOscillator();
            if (base64) {
              const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
              source.buffer = await context.decodeAudioData(bytes.buffer);
            } else source.frequency.value = 440;
            source.connect(destination);
            const entry = { context, source, stream: destination.stream, ended: false };
            source.onended = () => { entry.ended = true; };
            state.sources.push(entry);
            state.peak = Math.max(state.peak, state.sources.flatMap(s => s.stream.getTracks()).filter(t => t.readyState === "live").length);
            if (!base64) source.start();
            resolve(destination.stream);
          } catch (error) { await context.close(); reject(error); }
        };
        if (state.deferred) state.openings.push(open);
        else void open();
      });
    };
  }, wavBase64);
}

export async function prepareDraft(page) {
  await page.evaluate(() => {
    const area = window.__piWebVoice.findComposer();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, "Before selected after");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
    area.setSelectionRange(7, 15);
    window.__voiceInputs = 0;
  });
}

export async function recordingReady(page) {
  await waitFor(() => page.evaluate(() =>
    window.__piWebVoice.recorder.active && !window.__piWebVoice.ui.arming &&
    window.__piWebVoice.recorder.chunks.some(chunk => chunk.length > 0)), "recording samples");
}

export async function released(page) {
  await waitFor(() => page.evaluate(() => {
    const { recorder, ui } = window.__piWebVoice;
    return ui.state === "idle" && !ui.arming && !recorder.active && !recorder.stream &&
      !recorder.context && !recorder.closing && !recorder.source && !recorder.node && !recorder.mute &&
      window.__audioTest.contexts.every(c => c.state === "closed") &&
      window.__audioTest.sources.every(s => s.stream.getTracks().every(t => t.readyState === "ended"));
  }), "idle UI and released recording resources");
  await withTimeout(() => page.evaluate(async () => {
    for (const s of window.__audioTest.sources) {
      if (s.context.state === "closed") continue;
      try { s.source.stop(); } catch { /* a finite speech source can already be stopped */ }
      await s.context.close();
    }
  }), "synthetic audio context closure");
}

export async function observeRoundTrip(page, stop, timeout = 15_000) {
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/__voice/transcribe" && response.request().method() === "POST", { timeout });
  // Attach both handlers before invoking stop, including a synchronous throw.
  const [response] = await Promise.all([responsePromise, Promise.resolve().then(stop)]);
  const audio = response.request().postDataBuffer();
  assertRecordingWav(audio);
  assert.equal(new URL(response.request().url()).searchParams.get("audio_context"), "per-take");
  assert.match(response.headers()["x-pi-voice-request-id"] ?? "", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  // Avoid printing provider error bodies, even on failure in a live run.
  assert.equal(response.status(), 200, `transcription HTTP status is ${response.status()}`);
  const body = await readResponseBody(response, timeout);
  await released(page);
  const state = await page.evaluate(() => ({
    composed: window.__piWebVoice.findComposer().value,
    inputs: window.__voiceInputs,
    pending: window.__piWebVoice.ui.pending !== null,
    notice: window.__piWebVoice.ui.toastElement !== null,
    terminal: document.querySelector(".xterm-helper-textarea").value,
  }));
  return { body, ...state };
}
