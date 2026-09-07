/** Browser response handling without a browser, microphone or speech API. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/inject.js", import.meta.url), "utf8");

function harness(text, { language = "en" } = {}) {
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
  let respond = () => ({ ok: true, json: async () => ({ text }) });
  const window = {
    HTMLTextAreaElement: Textarea,
    EventSource: class {},
    confirm: () => true,
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return respond(url, init);
    },
  };
  const document = createDOM(composer, terminal);
  const timers = new Map();
  let clock = 0, nextTimer = 0;
  const schedule = (run, ms) => {
    const id = ++nextTimer;
    timers.set(id, { run, due: clock + ms });
    return id;
  };
  vm.runInNewContext(source, {
    window,
    navigator: { language },
    document,
    MutationObserver: class { observe() {} },
    Blob, Event, URLSearchParams, setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval, clearInterval,
  });
  const { ui, recorder } = window.__piWebVoice;
  const toast = ui.toast;
  ui.toast = (...args) => { notices.push(args[0]); return toast.apply(ui, args); };
  ui.state = "recording";
  recorder.active = true;
  // Three seconds of samples exercise the real WAV encoding and upload path.
  recorder.chunks = [new Float32Array(3 * 16000)];
  return {
    ui, recorder, composer, terminal, requests, notices, window, document, timers,
    setResponse(fn) { respond = fn; },
    advanceTime(ms) {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.due > clock) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

// Only the DOM surface used by the toolbar and real toast implementation.
// Response tests still use the real recorder, WAV encoder and composer setter.
function createDOM(composer, terminal) {
  function element(tag) {
    const node = new EventTarget();
    node.tagName = tag.toUpperCase();
    node.style = {};
    node.attributes = {};
    node.children = [];
    node.parentElement = null;
    node.setAttribute = (key, value) => { node.attributes[key] = value; };
    node.remove = () => {
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter(child => child !== node);
        node.parentElement = null;
      }
    };
    node.insertBefore = (child, anchor) => {
      child.remove();
      child.parentElement = node;
      const index = node.children.indexOf(anchor);
      node.children.splice(index < 0 ? node.children.length : index, 0, child);
    };
    node.appendChild = child => node.insertBefore(child, null);
    const glyph = () => ({ style: {}, classList: { toggle() {} } });
    const glyphs = {
      ".pi-voice-mic": glyph(),
      ".pi-voice-spin": glyph(),
      span: { style: {}, firstChild: { nodeValue: " " } },
    };
    node.querySelector = selector => glyphs[selector];
    node.querySelectorAll = () => [];
    return node;
  }
  const head = element("head"), body = element("body");
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  return {
    readyState: "loading",
    addEventListener() {},
    head, body,
    createElement: element,
    getElementById: id => [...descendants(head), ...descendants(body)].find(node => node.id === id) ?? null,
    querySelector: () => null,
    querySelectorAll: selector => selector === "textarea" ? [composer, terminal] : [],
  };
}

function mountToolbar(h) {
  const toolbar = h.document.createElement("div");
  const anchor = h.document.createElement("button");
  toolbar.appendChild(anchor);
  h.document.body.appendChild(toolbar);
  h.document.querySelector = selector => selector === 'button[title="Attach image"]' ? anchor : null;
  h.ui.mount();
  return toolbar;
}

const networkFailure = () => { throw new TypeError("Failed to fetch"); };
const success = text => ({ ok: true, json: async () => ({ text }) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

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
    assert.equal(h.ui.pending, null, "a successful VAD response is not a retryable error");
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
  assert.equal(h.ui.pending, null);
});

for (const [name, respond] of [
  ["network failure", networkFailure],
  ["HTTP error", () => ({ ok: false, json: async () => ({ error: "Service unavailable" }) })],
  ["non-JSON error page", () => ({ ok: false, json: async () => { throw new SyntaxError("Unexpected <"); } })],
  ["truncated JSON response", () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected end"); } })],
]) {
  test(`${name} retains the WAV through repeated failures and retries the same request`, async () => {
    const h = harness("");
    new h.window.EventSource("/api/agent/original%20session/events");
    h.ui.waitedMs = 321;
    h.setResponse(respond);
    await h.ui.stop();
    const take = h.ui.pending;
    assert.ok(take);
    assert.equal(take.wav, h.requests[0].body);
    assert.equal(take.wav.size, 44 + 3 * 16000 * 2);
    assert.equal(h.ui.state, "idle");
    assert.equal(h.recorder.active, false);
    assert.equal(h.recorder.chunks.length, 0);
    assert.equal(h.composer.value, "Keep my draft");
    assert.equal(h.composer.focused, false);
    assert.match(h.notices[0], /Transcription failed:/);
    assert.equal(h.requests.length, 1, "no automatic retries or surprise charges");

    h.recorder.start = () => assert.fail("retry must not open the microphone");
    h.recorder.stop = () => assert.fail("retry must not re-encode an empty recorder");
    await h.ui.retry();
    assert.equal(h.ui.pending, take);
    assert.equal(h.requests.length, 2);
    assert.equal(h.ui.state, "idle");

    h.ui.waitedMs = 999;
    h.setResponse(() => success("  恢复了整段话。  "));
    await h.ui.retry();
    assert.equal(h.requests.length, 3);
    for (const request of h.requests) {
      assert.equal(request.url, "/__voice/transcribe?session=original+session&wait=321");
      assert.equal(request.body, take.wav, "same Blob, not a new recording");
      assert.equal(request.method, "POST");
      assert.equal(request.headers["content-type"], "audio/wav");
      assert.equal(request.credentials, "include");
    }
    assert.equal(h.composer.value, "Keep my draft 恢复了整段话。");
    assert.deepEqual(h.composer.events, ["input"]);
    assert.equal(h.terminal.value, "Do not touch the terminal");
    assert.equal(h.ui.pending, null);
    assert.equal(h.ui.state, "idle");
    await h.ui.retry();
    assert.equal(h.requests.length, 3, "success clears the retry and cannot insert twice");
  });
}

test("retry locks both request and response-body processing against double clicks", async () => {
  const h = harness("");
  h.setResponse(networkFailure);
  await h.ui.stop();
  const response = deferred();
  const body = deferred();
  h.setResponse(() => response.promise);
  const attempt = h.ui.retry();
  assert.equal(h.ui.state, "working");
  await Promise.all([h.ui.retry(), h.ui.start(), h.ui.stop()]);
  h.ui.toggle();
  assert.equal(h.requests.length, 2);
  response.resolve({ ok: true, json: () => body.promise });
  await Promise.resolve();
  await h.ui.retry();
  assert.equal(h.requests.length, 2);
  body.resolve({ text: "Recovered once" });
  await attempt;
  assert.equal(h.composer.value, "Keep my draft Recovered once");
  assert.deepEqual(h.composer.events, ["input"]);
  assert.equal(h.ui.pending, null);
});

test("no captured audio neither uploads nor offers retry", async () => {
  const h = harness("");
  h.recorder.chunks = [];
  await h.ui.stop();
  await h.ui.retry();
  assert.equal(h.requests.length, 0);
  assert.equal(h.ui.pending, null);
  assert.equal(h.ui.state, "idle");
  assert.deepEqual(h.notices, ["No speech detected"]);
});

test("a successful empty retry leaves the draft alone and releases the recording", async () => {
  const h = harness("");
  h.setResponse(networkFailure);
  await h.ui.stop();
  h.setResponse(() => success("  "));
  await h.ui.retry();
  assert.equal(h.composer.value, "Keep my draft");
  assert.deepEqual(h.composer.events, []);
  assert.equal(h.ui.pending, null);
  assert.equal(h.notices.at(-1), "No speech detected");
});

test("a missing composer retains the transcript; retry inserts it without another upload", async () => {
  const h = harness("Recovered text");
  h.composer.offsetParent = null;
  await h.ui.stop();
  assert.equal(h.ui.pending.text, "Recovered text");
  assert.match(h.notices[0], /No composer found/);
  h.composer.offsetParent = {};
  await h.ui.retry();
  assert.equal(h.requests.length, 1);
  assert.equal(h.composer.value, "Keep my draft Recovered text");
  assert.equal(h.ui.pending, null);
});

test("switching conversations never submits or inserts a pending take into the wrong one", async () => {
  const h = harness("");
  new h.window.EventSource("/api/agent/original/events");
  h.setResponse(networkFailure);
  await h.ui.stop();
  const take = h.ui.pending;
  new h.window.EventSource("/api/agent/other/events");
  await h.ui.retry();
  assert.equal(h.requests.length, 1);
  assert.equal(h.ui.pending, take);
  assert.match(h.notices.at(-1), /Return to the conversation/);

  new h.window.EventSource("/api/agent/original/events");
  const response = deferred();
  h.setResponse(() => response.promise);
  const attempt = h.ui.retry();
  new h.window.EventSource("/api/agent/other/events");
  response.resolve(success("Original conversation's text"));
  await attempt;
  assert.equal(h.composer.value, "Keep my draft");
  assert.equal(h.ui.pending, take);
  new h.window.EventSource("/api/agent/original/events");
  await h.ui.retry();
  assert.equal(h.requests.length, 2, "already transcribed; do not pay twice");
  assert.equal(h.composer.value, "Keep my draft Original conversation's text");
  assert.equal(h.ui.pending, null);
});

for (const [language, label] of [["en", "Retry"], ["zh-CN", "重试"]]) {
  test(`${language} retry lives in the persistent red error notice, not the toolbar`, async () => {
    const h = harness("", { language });
    const toolbar = mountToolbar(h);
    assert.equal(h.ui.retryButton, null);
    h.setResponse(networkFailure);
    await h.ui.stop();
    const notice = h.ui.toastElement;
    const retry = h.ui.retryButton;
    assert.equal(notice.parentElement, h.document.body);
    assert.equal(notice.attributes.role, "alert");
    assert.match(notice.style.cssText, /background:#b4342c/);
    assert.equal(notice.children[0].textContent, h.notices[0], "keep the complete original error message");
    assert.match(notice.children[0].textContent, /Failed to fetch/);
    assert.equal(retry.parentElement, notice);
    assert.equal(retry.tagName, "BUTTON", "link appearance must retain action semantics");
    assert.equal(retry.type, "button");
    assert.equal(retry.textContent, label);
    assert.ok(retry.attributes["aria-label"]);
    assert.equal(retry.disabled, false);
    assert.equal(h.timers.size, 0, "retryable errors do not auto-dismiss");
    h.advanceTime(60_000);
    assert.equal(h.ui.toastElement, notice);
    const take = h.ui.pending;
    h.ui.button.remove();
    h.ui.mount();
    assert.equal(h.ui.retryButton, retry, "composer re-mounting leaves the error action intact");
    assert.equal(h.ui.pending, take);
    h.ui.mount();
    assert.equal(toolbar.children.length, 2, "only the microphone and original attach button");
    assert.equal(h.document.head.children.length, 1, "styles mounted once");

    h.recorder.warm = () => assert.fail("retry and a pending take must not warm the mic");
    h.ui.button.dispatchEvent(new Event("pointerdown"));
    retry.dispatchEvent(new Event("pointerdown"));
    const down = new Event("mousedown", { cancelable: true });
    retry.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true, "do not steal focus from the composer");
    const response = deferred();
    h.setResponse(() => response.promise);
    retry.dispatchEvent(new Event("click"));
    assert.equal(h.ui.state, "working");
    assert.equal(h.ui.toastElement, notice, "keep the error visible while retrying");
    assert.equal(notice.children[0].textContent, h.notices[0]);
    assert.equal(retry.disabled, true);
    assert.equal(retry.attributes["aria-busy"], "true");
    assert.equal(retry.textContent, language === "en" ? "Transcribing…" : "转写中…");
    retry.dispatchEvent(new Event("click"));
    assert.equal(h.requests.length, 2);
    response.resolve(success("Done"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.ui.pending, null);
    assert.equal(h.ui.retryButton, null);
    assert.equal(h.ui.toastElement, null);
    assert.equal(notice.parentElement, null, "success removes the error and its action together");
    assert.equal(h.composer.value, "Keep my draft Done");
  });
}

test("retry uses underlined text styling while keeping a touch target and keyboard focus cue", () => {
  const h = harness("");
  mountToolbar(h);
  const css = h.document.getElementById("pi-web-voice-style").textContent;
  const action = css.match(/#pi-web-voice-retry \{([^}]+)\}/)[1];
  for (const declaration of [
    "border:0", "background:transparent", "box-shadow:none", "color:inherit", "font:inherit",
    "text-decoration:underline", "min-width:44px", "min-height:44px",
  ]) {
    assert.ok(action.includes(declaration), declaration);
  }
  assert.match(css, /#pi-web-voice-retry:hover:not\(:disabled\) \{ text-decoration-thickness:2px; \}/);
  assert.match(css, /#pi-web-voice-retry:focus-visible \{ outline:2px solid #fff;/);
  assert.match(css, /#pi-web-voice-retry:disabled \{[^}]*text-decoration:none;/);
});

test("a failed retry replaces the error details without stacking notices or losing the action", async () => {
  const h = harness("");
  h.setResponse(networkFailure);
  await h.ui.stop();
  const original = h.ui.toastElement;
  const text = "503 <html>" + "provider-details".repeat(300) + "</html>";
  h.setResponse(() => ({ ok: false, json: async () => ({ error: text }) }));
  await h.ui.retry();
  assert.equal(original.parentElement, null);
  assert.equal(h.document.body.children.length, 1);
  assert.equal(h.ui.toastElement.children[0].textContent, `Transcription failed: ${text}`);
  assert.match(h.ui.toastElement.children[0].style.cssText, /overflow-wrap:anywhere/);
  assert.equal(h.ui.retryButton.parentElement, h.ui.toastElement);
  assert.equal(h.ui.retryButton.disabled, false);
  h.advanceTime(60_000);
  assert.equal(h.ui.toastElement.parentElement, h.document.body);
});

test("ordinary errors keep the original four-second notice and cannot later dismiss a retryable error", async () => {
  const h = harness("");
  h.ui.toast("Microphone permission denied");
  const ordinary = h.ui.toastElement;
  assert.equal(h.ui.retryButton, null);
  assert.equal(ordinary.children[0].textContent, "Microphone permission denied");
  h.advanceTime(3999);
  assert.equal(h.ui.toastElement, ordinary);
  h.advanceTime(1);
  assert.equal(h.ui.toastElement, null);
  assert.equal(ordinary.parentElement, null);

  h.ui.toast("No speech detected");
  h.advanceTime(2000);
  h.setResponse(networkFailure);
  await h.ui.stop();
  const failed = h.ui.toastElement;
  h.advanceTime(4000);
  assert.equal(h.ui.toastElement, failed, "the old notice's timer was cancelled");
  assert.equal(failed.parentElement, h.document.body);

  h.setResponse(() => success(""));
  await h.ui.retry();
  assert.equal(failed.parentElement, null);
  assert.equal(h.ui.retryButton, null);
  assert.equal(h.ui.toastElement.children[0].textContent, "No speech detected");
  h.advanceTime(4000);
  assert.equal(h.ui.toastElement, null);
});

test("starting over requires confirmation and a working microphone before discarding the old take", async t => {
  const h = harness("");
  mountToolbar(h);
  h.setResponse(networkFailure);
  await h.ui.stop();
  const take = h.ui.pending;
  let confirmations = 0;
  h.window.confirm = () => { confirmations += 1; return false; };
  h.recorder.start = () => assert.fail("declining must not open the microphone");
  await h.ui.start();
  assert.equal(confirmations, 1);
  assert.equal(h.ui.pending, take);
  assert.equal(h.ui.state, "idle");

  h.window.confirm = () => true;
  h.recorder.start = async () => { throw Object.assign(new Error("Denied"), { name: "NotAllowedError" }); };
  await h.ui.start();
  assert.equal(h.ui.pending, take);
  assert.equal(h.ui.arming, false);
  assert.equal(h.ui.retryButton.disabled, false);
  assert.equal(h.ui.toastElement.children[0].textContent, "Microphone permission denied");

  const opening = deferred();
  h.recorder.start = () => opening.promise;
  const cancelled = h.ui.start();
  await h.ui.stop();
  opening.resolve();
  await cancelled;
  assert.equal(h.ui.pending, take);
  assert.equal(h.ui.arming, false);
  assert.equal(h.ui.retryButton.disabled, false);
  assert.equal(h.ui.retryButton.parentElement, h.ui.toastElement);
  assert.equal(h.requests.length, 1);

  const deniedAfterCancel = deferred();
  h.recorder.start = () => deniedAfterCancel.promise;
  const cancelledFailure = h.ui.start();
  await h.ui.stop();
  deniedAfterCancel.reject(new Error("Late permission failure"));
  await cancelledFailure;
  assert.equal(h.ui.pending, take);
  assert.equal(h.ui.arming, false);
  assert.equal(h.ui.retryButton.disabled, false);
  assert.equal(h.ui.retryButton.parentElement, h.ui.toastElement);

  h.recorder.start = async () => { h.recorder.startedAt = Date.now(); };
  t.after(() => clearInterval(h.ui.timer));
  await h.ui.start();
  assert.equal(h.ui.state, "recording");
  assert.equal(h.ui.pending, null);
  assert.equal(h.ui.retryButton, null);
  assert.equal(h.ui.toastElement, null);
});
