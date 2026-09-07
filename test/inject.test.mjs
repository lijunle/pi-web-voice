/** Browser response handling without a browser, microphone or speech API. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/inject.js", import.meta.url), "utf8");

function harness(text) {
  class Textarea {
    constructor(value, terminal = false) {
      this._value = value;
      this.selectionStart = this.selectionEnd = value.length;
      this.offsetParent = {};
      this.classList = { contains: name => terminal && name === "xterm-helper-textarea" };
      this.closest = () => terminal ? {} : null;
      this.events = [];
      this.focused = false;
    }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    dispatchEvent(event) { this.events.push(event.type); }
    focus() { this.focused = true; }
  }
  const composer = new Textarea("Keep my draft");
  const terminal = new Textarea("Do not touch the terminal", true);
  const requests = [], notices = [];
  const window = {
    HTMLTextAreaElement: Textarea,
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return { ok: true, json: async () => ({ text }) };
    },
  };
  vm.runInNewContext(source, {
    window,
    navigator: { language: "en" },
    document: {
      readyState: "loading",
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: selector => selector === "textarea" ? [composer, terminal] : [],
    },
    MutationObserver: class { observe() {} },
    Blob, Event, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const { ui, recorder } = window.__piWebVoice;
  ui.toast = message => notices.push(message);
  ui.state = "recording";
  recorder.active = true;
  // Three seconds of samples exercise the real WAV encoding and upload path.
  recorder.chunks = [new Float32Array(3 * 16000)];
  return { ui, recorder, composer, terminal, requests, notices };
}

for (const text of ["", " \n\t "]) {
  test(`an ${text ? "all-whitespace" : "empty"} transcript preserves draft, selection and focus`, async () => {
    const h = harness(text);
    h.composer.setSelectionRange(2, 5);
    await h.ui.stop();
    assert.equal(h.requests.length, 1, "no local duration or loudness gate replaces service VAD");
    assert.equal(h.requests[0].url, "/__voice/transcribe");
    assert.equal(h.requests[0].body.size, 44 + 3 * 16000 * 2);
    assert.equal(h.composer.value, "Keep my draft");
    assert.equal(h.composer.selectionStart, 2);
    assert.equal(h.composer.selectionEnd, 5);
    assert.equal(h.composer.focused, false);
    assert.deepEqual(h.composer.events, []);
    assert.equal(h.terminal.value, "Do not touch the terminal");
    assert.deepEqual(h.notices, ["No speech detected"]);
    assert.equal(h.ui.state, "idle");
    assert.equal(h.recorder.active, false);
  });
}

test("a nonempty transcript still inserts into the composer, not the terminal", async () => {
  const h = harness("  好。  ");
  await h.ui.stop();
  assert.equal(h.composer.value, "Keep my draft 好。");
  assert.equal(h.composer.selectionStart, h.composer.value.length);
  assert.equal(h.composer.focused, true);
  assert.deepEqual(h.composer.events, ["input"]);
  assert.equal(h.terminal.value, "Do not touch the terminal");
  assert.deepEqual(h.notices, []);
  assert.equal(h.ui.state, "idle");
});
