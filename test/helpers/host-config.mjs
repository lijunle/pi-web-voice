/** Serialize literal voice.env values without exporting credentials or re-parsing quotes. */
import assert from "node:assert/strict";

const keys = new Set([
  "PI_VOICE_PROVIDER", "AZURE_SPEECH_ENDPOINT", "AZURE_SPEECH_KEY",
  "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "PI_VOICE_DEPLOYMENT",
  "PI_VOICE_OPENAI_BASE_URL", "OPENAI_API_KEY", "PI_VOICE_OPENAI_MODEL",
]);

export function serializeSettings(settings) {
  assert.ok(Object.hasOwn(settings, "PI_VOICE_PROVIDER") &&
    ["mock", "azure-openai", "azure-speech", "openai"].includes(settings.PI_VOICE_PROVIDER), "select a known provider explicitly");
  return Object.entries(settings).map(([key, value]) => {
    assert.ok(keys.has(key), "temporary configuration accepts only voice settings");
    assert.equal(typeof value, "string", "configuration values are strings");
    assert.ok(!/[\r\n\0]/.test(value), "configuration values occupy one line");
    // The project's parser removes exactly one matching outer quote pair and
    // performs no shell expansion or unescaping. An extra pair preserves literals.
    return `${key}="${value}"`;
  }).join("\n");
}
