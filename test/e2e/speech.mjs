/** Opt-in live E2E: Playwright → isolated pi-web → real speech provider → composer. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { withHost } from "../helpers/host.mjs";
import { openBrowser, waitFor } from "../helpers/browser.mjs";
import { mountVoice, installAudio, prepareDraft, recordingReady, observeRoundTrip } from "../helpers/voice-page.mjs";
import { assertRoundTrip } from "../helpers/round-trip.mjs";

assert.equal(process.env.PI_VOICE_TEST_LIVE, "1",
  "Live E2E requires explicit authorization: use npm run test:e2e (native test discovery is not opt-in)");
const require = createRequire(import.meta.url);
const { loadConfig } = require("../../lib/config.cjs");
const config = loadConfig();
assert.ok(["azure-openai", "azure-speech", "openai"].includes(config.provider),
  "test:e2e requires a real speech provider; configure voice.env or service environment (mock belongs to test:integration)");
let settings;
if (config.provider === "azure-openai") {
  assert.ok(config.azureOpenAI.endpoint && config.azureOpenAI.key, "configure AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY");
  settings = {
    AZURE_OPENAI_ENDPOINT: config.azureOpenAI.endpoint, AZURE_OPENAI_API_KEY: config.azureOpenAI.key,
    PI_VOICE_DEPLOYMENT: config.azureOpenAI.deployment,
  };
} else if (config.provider === "azure-speech") {
  assert.ok(config.azureSpeech.endpoint && config.azureSpeech.key, "configure AZURE_SPEECH_ENDPOINT and AZURE_SPEECH_KEY");
  settings = { AZURE_SPEECH_ENDPOINT: config.azureSpeech.endpoint, AZURE_SPEECH_KEY: config.azureSpeech.key };
} else {
  settings = {
    PI_VOICE_OPENAI_BASE_URL: config.openai.baseUrl, OPENAI_API_KEY: config.openai.key,
    PI_VOICE_OPENAI_MODEL: config.openai.model,
  };
}
settings.PI_VOICE_PROVIDER = config.provider;
const wav = readFileSync(new URL("../fixtures/voice-en.wav", import.meta.url));
console.log(`Live E2E · provider=${config.provider} · one synthetic speech take; provider usage may be billed`);

await withHost(settings, async (origin, signal) => {
  const { browser, page } = await openBrowser({ signal });
  try {
    const traffic = await mountVoice(page, origin, { live: true });
    const uploads = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/__voice/transcribe") uploads.push(request);
    });
    await installAudio(page, wav.toString("base64"));
    await prepareDraft(page);
    const mic = page.locator("#pi-web-voice-button");
    await mic.click();
    await recordingReady(page);
    // Start the speech only after the recorder collects samples, preserving
    // the beginning of the fixture through asynchronous microphone setup.
    await page.evaluate(() => window.__audioTest.sources[0].source.start());
    await waitFor(() => page.evaluate(() => window.__audioTest.sources[0].ended), "synthetic speech playback", 15_000);
    const chunks = await page.evaluate(() => window.__piWebVoice.recorder.chunks.length);
    await waitFor(() => page.evaluate(n => window.__piWebVoice.recorder.chunks.length >= n + 2, chunks), "final speech callbacks");
    // Permit one POST only after the complete synthetic take is ready. Any
    // early upload or duplicate is blocked before it can reach the paid service.
    assert.equal(traffic.violations.length, 0, "setup and capture make no unexpected requests");
    traffic.permitUpload();
    const result = await observeRoundTrip(page, () => mic.click(), 90_000);
    assertRoundTrip(result, config.provider);
    const normalized = result.body.text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
    assert.ok(normalized.includes("voice input test") && normalized.includes("quick brown fox"),
      "the live provider recognizes both phrases in the synthetic speech fixture");
    assert.equal(uploads.length, 1, "one browser upload, without automatic browser retry");
    assert.equal(traffic.uploads, 1, "the network guard permits just one live upload");
    assert.equal(traffic.violations.length, 0, "no extra uploads, chat submissions, or agent starts");
    console.log("Live E2E passes: speech recognized, response inserted once, draft/terminal preserved, audio resources closed");
  } finally {
    await browser.close();
  }
});
