/** Real pi-web + checkout hook + Playwright Chromium + local mock transcription. */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { withHost } from "../helpers/host.mjs";
import { openBrowser, waitFor } from "../helpers/browser.mjs";
import { mountVoice, installAudio, prepareDraft, recordingReady, released, observeRoundTrip } from "../helpers/voice-page.mjs";
import { assertRoundTrip, readResponseBody } from "../helpers/round-trip.mjs";

let checks = 0;
function check(name, condition = true) {
  assert.ok(condition, name);
  console.log(`ok  ${name}`);
  checks++;
}

await withHost({ PI_VOICE_PROVIDER: "mock" }, async (origin, signal) => {
  const { browser, page } = await openBrowser({ signal });
  try {
    const traffic = await mountVoice(page, origin);
    check("checkout script mounts in real pi-web, in a secure context, beside the composer");
    await installAudio(page);
    const uploads = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/__voice/transcribe") uploads.push(request);
    });
    const mic = page.locator("#pi-web-voice-button");

    await mic.dispatchEvent("pointerdown");
    await sleep(1600); // Deliberately exceed the former pointer prewarm window.
    check("a held pointer does not acquire the microphone", await page.evaluate(() =>
      window.__audioTest.calls === 0 && window.__piWebVoice.ui.state === "idle"));
    await mic.dispatchEvent("pointerleave");
    await mic.dispatchEvent("pointercancel");
    check("an abandoned pointer gesture stays idle", await page.evaluate(() => window.__audioTest.calls === 0));

    await page.evaluate(() => { window.__audioTest.deferred = true; });
    await mic.click();
    check("opening paints immediately before acquisition resolves", await mic.textContent() === "…");
    await mic.click();
    // Dispatch DOM activation even while disabled: the controller must guard it too.
    await mic.evaluate(button => { for (let i = 0; i < 5; i++) button.click(); });
    check("rapid start-cancel-start retains one pending opening", await page.evaluate(() =>
      window.__audioTest.calls === 1 && window.__piWebVoice.ui.arming && window.__piWebVoice.ui.state === "idle"));
    await page.evaluate(() => window.__audioTest.openings.shift()());
    await released(page);
    check("a cancelled late stream and context close without an upload", uploads.length === 0);

    // Consecutive takes share a page and composer, but never audio resources.
    for (let take = 0; take < 3; take++) {
      await prepareDraft(page);
      const before = uploads.length;
      const contextCount = await page.evaluate(() => window.__audioTest.contexts.length);
      await page.evaluate(deferred => { window.__audioTest.deferred = deferred; }, take === 1);
      if (take === 0) {
        await mic.focus();
        await page.keyboard.press("Enter");
      } else if (take === 1) {
        await mic.evaluate(button => button.click()); // Keyboard/VoiceOver-style activation.
        check("delayed opening keeps the readiness clock hidden", await mic.textContent() === "…");
        await sleep(150); // A controlled acquisition delay, not a readiness guess.
        await page.evaluate(() => window.__audioTest.openings.shift()());
      } else await mic.click();
      await recordingReady(page);
      check(`take ${take + 1}: one fresh context captures real synthetic samples`, await page.evaluate(count =>
        window.__audioTest.contexts.length === count + 1 && window.__audioTest.peak === 1 &&
        window.__piWebVoice.recorder.context === window.__audioTest.contexts.at(-1), contextCount));
      check(`take ${take + 1}: clock follows graph readiness`, /^\d+:\d{2}$/.test(await mic.textContent()));
      if (take === 1) check("opening latency includes the controlled acquisition wait", await page.evaluate(() => window.__piWebVoice.ui.waitedMs >= 150));

      let stop = () => mic.click();
      if (take === 0) {
        stop = async () => {
          const clock = mic.locator("span");
          const box = await clock.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          try {
            const pressedTick = await clock.textContent();
            await waitFor(async () => await clock.textContent() !== pressedTick, "clock tick during held mouse click");
          } finally {
            await page.mouse.up();
          }
        };
      } else if (take === 2) {
        const samples = await page.evaluate(() => {
          window.__piWebVoice.recorder.startedAt = Date.now() - 590_000;
          return window.__piWebVoice.recorder.chunks.length;
        });
        await waitFor(() => page.evaluate(n => window.__piWebVoice.recorder.chunks.length > n, samples), "audio callback before recording limit");
        check("recording continues before ten minutes", await page.evaluate(() => window.__piWebVoice.recorder.active));
        stop = () => page.evaluate(() => { window.__piWebVoice.recorder.startedAt = Date.now() - 601_000; });
      }
      const result = await observeRoundTrip(page, stop);
      assertRoundTrip(result, "mock");
      check(`take ${take + 1}: successful response inserts exactly once and preserves draft/terminal`, uploads.length === before + 1);
      check(`take ${take + 1}: context, stream, graph and pending audio all release`);
      if (take === 0) check("one real mouse click stops across an observed clock tick");
      if (take === 2) check("an audio callback stops the take after ten minutes");
    }
    // Exercise the actual hook's signal gate with captured synthetic silence,
    // then recover through the real UI and mock adapter without rewriting text.
    await prepareDraft(page);
    await page.evaluate(() => { window.__audioTest.deferred = false; window.__audioTest.silent = true; });
    await mic.click();
    await recordingReady(page);
    const responseForVoice = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === "/__voice/transcribe" && response.request().method() === "POST", { timeout: 15_000 });
    const [skipped] = await Promise.all([responseForVoice(), mic.click()]);
    const skipBody = await readResponseBody(skipped);
    await released(page);
    const silentWav = skipped.request().postDataBuffer();
    check("a real silent capture gets HTTP 422 from the hook before mock transcription",
      skipped.status() === 422 && skipBody.code === "silence_detected" && skipBody.text === undefined
      && silentWav.length > 44 && silentWav.subarray(44).every(byte => byte === 0));
    check("the silence notice preserves the real composer and retained take", await page.evaluate(() =>
      window.__piWebVoice.findComposer().value === "Before selected after" && window.__voiceInputs === 0
      && window.__piWebVoice.ui.pending?.silenceDetected === true
      && window.__piWebVoice.ui.retryButton.textContent === "Transcribe anyway"));
    const opens = await page.evaluate(() => window.__audioTest.calls);
    const [bypassed] = await Promise.all([responseForVoice(), page.locator("#pi-web-voice-retry").click()]);
    const recovered = await readResponseBody(bypassed);
    await released(page);
    check("explicit silence recovery resends the same WAV with a request-scoped bypass",
      bypassed.status() === 200 && bypassed.request().headers()["x-pi-voice-silence-check"] === "bypass"
      && bypassed.request().postDataBuffer().equals(silentWav));
    assertRoundTrip({ body: recovered, ...await page.evaluate(() => ({
      composed: window.__piWebVoice.findComposer().value, inputs: window.__voiceInputs,
      pending: window.__piWebVoice.ui.pending !== null, notice: window.__piWebVoice.ui.toastElement !== null,
      terminal: document.querySelector(".xterm-helper-textarea").value,
    })) }, "mock");
    check("silence recovery inserts exactly once and clears its pending audio");
    check("silence recovery keeps the microphone closed", await page.evaluate(count => window.__audioTest.calls === count, opens));

    check("voice never submits chat or starts an agent", traffic.violations.length === 0);
    assert.equal(traffic.uploads, 5, "three audible takes, one silence skip, and one explicit bypass upload");
    check("all recorded takes use distinct contexts", await page.evaluate(() =>
      new Set(window.__audioTest.contexts).size === window.__audioTest.contexts.length));
  } finally {
    await browser.close();
  }
});
console.log(`\n${checks}/${checks} pi-web integration checks passed`);
