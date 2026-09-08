/** Browser response handling without a browser, microphone or speech API. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/inject.js", import.meta.url), "utf8");
const SERVER_EMPTY = "[Server · empty transcript] Audio was submitted, but the server returned no transcription text (HTTP 200)";

function harness(text, { language = "en", now = Date.now } = {}) {
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
  const requests = [], notices = [], logs = [];
  let respond = () => success(text);
  const navigator = { language };
  const window = {
    isSecureContext: true,
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
    navigator,
    document,
    MutationObserver: class { observe() {} },
    console: Object.fromEntries(["log", "warn", "error", "debug"].map(level => [level, (...args) => logs.push(args)])),
    Blob, Event, URLSearchParams, Date: class extends Date { static now() { return now(); } },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
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
    ui, recorder, composer, terminal, requests, notices, logs, window, document, timers, navigator,
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
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function rawResponse(body, status = 200, type, headers = {}) {
  return new Response(typeof body === "string" ? new TextEncoder().encode(body) : body, {
    status, headers: { ...(type ? { "content-type": type } : {}), ...headers },
  });
}
function interruptedResponse(status = 200, error = new TypeError("Connection closed")) {
  return rawResponse(new ReadableStream({ start(controller) { controller.error(error); } }), status, "application/json");
}
const success = (text, headers) => jsonResponse({ text }, 200, headers);
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
    assert.deepEqual(h.notices, [SERVER_EMPTY]);
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

for (const [name, respond, prefix] of [
  ["network failure", networkFailure, "[Network]"],
  ["HTTP error", () => jsonResponse({ error: "Service unavailable" }, 502), "[Server]"],
  ["non-JSON error page", () => rawResponse("<html>Bad Gateway</html>", 503, "text/html"), "[Server]"],
  ["truncated JSON response", () => rawResponse('{"text":', 200, "application/json"), "[Server response]"],
  ["interrupted response body", () => interruptedResponse(), "[Network]"],
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
    assert.ok(h.notices[0].startsWith(prefix), h.notices[0]);
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
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  h.setResponse(() => response.promise);
  const attempt = h.ui.retry();
  assert.equal(h.ui.state, "working");
  await Promise.all([h.ui.retry(), h.ui.start(), h.ui.stop()]);
  h.ui.toggle();
  assert.equal(h.requests.length, 2);
  response.resolve(rawResponse(body, 200, "application/json"));
  await Promise.resolve();
  await h.ui.retry();
  assert.equal(h.requests.length, 2);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: "Recovered once" })));
  controller.close();
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
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^\[Client · recording\].*nothing was uploaded/);
  assert.doesNotMatch(h.notices[0], /Server|No speech detected/);
});

for (const [language, clientPrefix, serverPrefix] of [
  ["en", "[Client · recording]", "[Server · empty transcript]"],
  ["zh-CN", "[客户端·录音]", "[服务端·空结果]"],
]) {
  test(`${language} clearly distinguishes no local samples from an empty server transcript`, async () => {
    const local = harness("", { language });
    local.recorder.chunks = [];
    await local.ui.stop();
    const remote = harness("", { language });
    await remote.ui.stop();
    assert.ok(local.notices[0].startsWith(clientPrefix));
    assert.ok(remote.notices[0].startsWith(serverPrefix));
    assert.equal(local.requests.length, 0);
    assert.equal(remote.requests.length, 1);
    assert.match(remote.notices[0], /HTTP 200/);
    assert.equal(local.ui.pending, null);
    assert.equal(remote.ui.pending, null);
  });
}

for (const payload of [null, {}, { text: null }, { text: 42 }, { text: [] }]) {
  test(`malformed successful response ${JSON.stringify(payload)} is retryable, not no-speech`, async () => {
    const h = harness("");
    h.setResponse(() => jsonResponse(payload));
    await h.ui.stop();
    assert.match(h.notices[0], /^\[Server response\].*HTTP 200/);
    assert.ok(h.ui.pending?.wav);
    assert.equal(h.ui.pending.text, undefined);
    assert.equal(h.ui.retryButton.disabled, false);
    assert.equal(h.composer.value, "Keep my draft");
    h.setResponse(() => success("Recovered"));
    await h.ui.retry();
    assert.equal(h.composer.value, "Keep my draft Recovered");
    assert.equal(h.ui.pending, null);
  });
}

test("HTTP failures keep the status and details, including non-JSON gateway responses", async () => {
  for (const status of [401, 429, 500, 502, 503]) {
    const h = harness("");
    h.setResponse(() => jsonResponse({ error: "Original diagnosis" }, status));
    await h.ui.stop();
    assert.equal(h.notices[0], `[Server] Transcription request failed (HTTP ${status}): Original diagnosis`);
    assert.ok(h.ui.pending);
  }
  const h = harness("");
  h.setResponse(() => rawResponse("<html>Bad Gateway</html>", 502, "text/html"));
  await h.ui.stop();
  assert.match(h.notices[0], /^\[Server\].*HTTP 502.*HTML instead of JSON/);
  assert.doesNotMatch(h.notices[0], /Unexpected|expected pattern/);
});

const invalidBodies = [
  ["HTML", '<!doctype html><html>PRIVATE_BODY<script>globalThis.bad=true</script></html>', "text/html; charset=utf-8", "HTML instead of JSON", "HTML，而不是 JSON"],
  ["plain text", "PRIVATE_BODY upstream connection refused", "text/plain", "non-JSON response", "非 JSON 响应"],
  ["empty body", "", "text/plain", "empty response", "空响应"],
  ["whitespace body", " \r\n\t", "application/json", "empty response", "空响应"],
  ["truncated JSON", '{"text":"PRIVATE_BODY', "application/json", "invalid or incomplete JSON", "无效或不完整的 JSON"],
  ["HTML mislabeled as JSON", "<html>PRIVATE_BODY</html>", "application/json", "HTML instead of JSON", "HTML，而不是 JSON"],
  ["JSON prefix without Content-Type", '{"text":"PRIVATE_BODY', undefined, "invalid or incomplete JSON", "无效或不完整的 JSON"],
];
for (const [name, body, type, english, chinese] of invalidBodies) {
  for (const status of [200, 502]) {
    test(`${name} with HTTP ${status} has a stable diagnosis and retains the exact WAV`, async () => {
      for (const language of ["en", "zh-CN"]) {
        const h = harness("", { language });
        const reply = rawResponse(body, status, type);
        h.setResponse(() => reply);
        await h.ui.stop();
        const expectedPrefix = language === "en" ? (status === 200 ? "[Server response]" : "[Server]")
          : (status === 200 ? "[服务端响应]" : "[服务端]");
        assert.ok(h.notices[0].startsWith(expectedPrefix));
        assert.ok(h.notices[0].includes(`HTTP ${status}`));
        assert.ok(h.notices[0].includes(language === "en" ? english : chinese));
        assert.doesNotMatch(h.notices[0], /PRIVATE_BODY|<script>|Unexpected|expected pattern/);
        assert.equal(reply.bodyUsed, true, "the real response body was consumed");
        assert.equal(h.ui.pending.wav, h.requests[0].body);
        assert.equal(h.ui.pending.text, undefined);
        assert.equal(h.ui.retryButton.disabled, false);
        assert.equal(h.composer.value, "Keep my draft");
        assert.deepEqual(h.logs, [], "neither raw response bodies nor parser exceptions are logged");
        h.setResponse(() => success("Recovered"));
        await h.ui.retry();
        assert.equal(h.requests[1].body, h.requests[0].body);
        assert.equal(h.composer.value, "Keep my draft Recovered");
        assert.equal(h.ui.pending, null);
      }
    });
  }
}

test("Safari's generic Response.json SyntaxError is never used; text is read exactly once", async () => {
  const h = harness("");
  const reply = rawResponse("<html>Bad Gateway</html>", 502, "text/html");
  const read = reply.text.bind(reply);
  let textReads = 0, jsonReads = 0;
  reply.text = () => { textReads += 1; return read(); };
  reply.json = async () => {
    jsonReads += 1;
    throw new DOMException("The string did not match the expected pattern.", "SyntaxError");
  };
  h.setResponse(() => reply);
  await h.ui.stop();
  assert.equal(textReads, 1);
  assert.equal(jsonReads, 0);
  assert.equal(h.notices[0], "[Server] Transcription request failed (HTTP 502): Server or gateway returned HTML instead of JSON; recording kept for retry");
  assert.ok(h.ui.pending?.wav);
});

for (const status of [200, 502]) {
  test(`body-read failure remains a network/read error even after HTTP ${status} headers`, async () => {
    const h = harness("");
    h.setResponse(() => interruptedResponse(status, new DOMException("PRIVATE_BODY expected pattern", "SyntaxError")));
    await h.ui.stop();
    assert.equal(h.notices[0], `[Network] Could not finish reading the server response; recording kept for retry (HTTP ${status})`);
    assert.ok(h.ui.pending?.wav);
    assert.equal(h.ui.retryButton.disabled, false);
    assert.deepEqual(h.logs, []);
  });
}

test("valid JSON is accepted despite an incorrect or missing Content-Type", async () => {
  for (const type of [undefined, "text/plain", "text/html", "application/problem+json"]) {
    const h = harness("");
    const reply = rawResponse(JSON.stringify({ text: "  好。  " }), 200, type);
    h.setResponse(() => reply);
    await h.ui.stop();
    assert.equal(h.composer.value, "Keep my draft 好。");
    assert.deepEqual(h.notices, []);
    assert.equal(reply.bodyUsed, true);
  }
});

test("only an explicit empty text field is a successful empty result; 204 and empty 200 stay retryable", async () => {
  for (const reply of [rawResponse(null, 204), rawResponse("", 200, "application/json")]) {
    const h = harness("");
    h.setResponse(() => reply);
    await h.ui.stop();
    assert.match(h.notices[0], /^\[Server response\].*empty response/);
    assert.ok(h.ui.pending?.wav);
  }
  const h = harness("");
  await h.ui.stop();
  assert.equal(h.notices[0], SERVER_EMPTY);
  assert.equal(h.ui.pending, null);
});

test("structured HTTP error details stay intact without being written to logs", async () => {
  const detail = "PRIVATE_STRUCTURED_DIAGNOSIS";
  for (const payload of [{ error: detail }, { error: { message: detail } }, { message: detail }, { detail }, detail]) {
    const h = harness("");
    h.setResponse(() => jsonResponse(payload, 502));
    await h.ui.stop();
    assert.equal(h.notices[0], `[Server] Transcription request failed (HTTP 502): ${detail}`);
    assert.deepEqual(h.logs, []);
    assert.ok(h.ui.pending?.wav);
  }
});

test("non-JSON diagnoses retain safe request IDs but not arbitrary header or body content", async () => {
  const id = "8dd5d2dc-977c-42e4-b17d-2093c43a16b1";
  const h = harness("");
  h.setResponse(() => rawResponse("PRIVATE_BODY", 502, "application/PRIVATE_HEADER", { "x-pi-voice-request-id": id }));
  await h.ui.stop();
  assert.ok(h.notices[0].includes(`HTTP 502 · request ${id}`));
  assert.doesNotMatch(h.notices[0], /PRIVATE_/);
  assert.deepEqual(h.logs, []);
});

test("server notices include a validated request ID when available, not arbitrary header content", async () => {
  const id = "e11d3797-1dd4-424d-af56-84f84dcb923f";
  const h = harness("");
  h.setResponse(() => jsonResponse({ error: "Service failed" }, 500, { "x-pi-voice-request-id": id }));
  await h.ui.stop();
  assert.ok(h.notices[0].includes(`HTTP 500 · request ${id}`));
  h.setResponse(() => success("", { "x-pi-voice-request-id": id }));
  await h.ui.retry();
  assert.ok(h.notices.at(-1).startsWith("[Server · empty transcript]"));
  assert.ok(h.notices.at(-1).includes(`request ${id}`));

  const invalid = harness("");
  invalid.setResponse(() => success("", { "x-pi-voice-request-id": "PRIVATE_HEADER_do_not_display" }));
  await invalid.ui.stop();
  assert.equal(invalid.notices[0], SERVER_EMPTY);
});

test("composer failures are client errors and retry uses the cached text", async () => {
  const h = harness("Recovered");
  const proto = h.window.HTMLTextAreaElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "value");
  Object.defineProperty(proto, "value", { ...original, set() { throw new Error("Composer not writable"); } });
  await h.ui.stop();
  assert.match(h.notices[0], /^\[Client\].*Composer not writable/);
  assert.equal(h.ui.pending.text, "Recovered");
  assert.equal(h.composer.value, "Keep my draft");
  Object.defineProperty(proto, "value", original);
  await h.ui.retry();
  assert.equal(h.requests.length, 1);
  assert.equal(h.composer.value, "Keep my draft Recovered");
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
  assert.equal(h.notices.at(-1), SERVER_EMPTY);
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

    h.navigator.mediaDevices = { getUserMedia: () => assert.fail("retry and pointer events must not open the mic") };
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
  h.setResponse(() => jsonResponse({ error: text }, 503));
  await h.ui.retry();
  assert.equal(original.parentElement, null);
  assert.equal(h.document.body.children.length, 1);
  assert.equal(h.ui.toastElement.children[0].textContent, `[Server] Transcription request failed (HTTP 503): ${text}`);
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
  assert.equal(h.ui.toastElement.children[0].textContent, SERVER_EMPTY);
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
  assert.equal(h.ui.toastElement.children[0].textContent, "[Client · microphone] Could not start the microphone: Microphone permission denied");

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

function audioHarness(state = "running", resumeMode = "resolve", options = {}) {
  const h = harness("", options);
  const contexts = [], tracks = [];
  h.window.AudioContext = class {
    constructor() {
      this.state = "running";
      this.sampleRate = 48000;
      this.destination = {};
      this.resumes = this.closes = 0;
      contexts.push(this);
    }
    async resume() {
      this.resumes += 1;
      if (resumeMode === "reject") throw new Error("Resume rejected");
      if (resumeMode === "pending") return new Promise(() => {});
      if (resumeMode === "resolve") this.state = "running";
    }
    async close() { this.closes += 1; this.state = "closed"; }
    async suspend() { this.state = "suspended"; }
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
  };
  h.navigator.mediaDevices = { getUserMedia: async () => {
    const track = { readyState: "live", stop() { this.readyState = "ended"; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  } };
  if (state !== "missing") {
    h.recorder.context = new h.window.AudioContext();
    h.recorder.context.state = state;
  }
  h.ui.state = "idle";
  h.recorder.active = false;
  h.recorder.chunks = [];
  return { ...h, contexts, tracks };
}

for (const state of ["missing", "running", "suspended", "interrupted", "closed"]) {
  test(`microphone opening handles an AudioContext that is ${state}`, async () => {
    const h = audioHarness(state);
    const original = h.recorder.context;
    const stream = await h.recorder.open();
    assert.equal(h.recorder.context.state, "running");
    assert.equal(h.recorder.context.resumes, ["suspended", "interrupted"].includes(state) ? 1 : 0);
    if (["missing", "closed"].includes(state)) assert.notEqual(h.recorder.context, original);
    else assert.equal(h.recorder.context, original);
    assert.equal(h.timers.size, 0);
    stream.getTracks().forEach(track => track.stop());
    h.recorder.discardContext();
  });
}

for (const mode of ["reject", "stalled", "pending"]) {
  test(`an interrupted context whose resume is ${mode} fails locally and releases the microphone`, async () => {
    const h = audioHarness("interrupted", mode);
    const starting = h.ui.start();
    if (mode === "pending") {
      for (let i = 0; i < 10 && h.timers.size === 0; i += 1) await Promise.resolve();
      assert.equal(h.timers.size, 1);
      h.advanceTime(3000);
    }
    await starting;
    assert.equal(h.ui.state, "idle");
    assert.equal(h.ui.arming, false);
    assert.equal(h.recorder.context, null);
    assert.equal(h.tracks.length, 1);
    assert.equal(h.tracks[0].readyState, "ended");
    assert.match(h.notices[0], /^\[Client · audio\]/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.ui.retryButton, null);
    assert.equal(h.contexts[0].closes, 1);
  });
}

test("pointer presses, long holds and abandoned touches never open the microphone", async () => {
  const h = audioHarness("missing");
  mountToolbar(h);
  for (const type of ["pointerdown", "mousedown", "pointerleave", "pointercancel", "pointerup", "mouseup"]) {
    h.ui.button.dispatchEvent(new Event(type));
    h.advanceTime(2000);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.tracks.length, 0);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.timers.size, 0, "no pre-warm expiry timer");
  assert.equal(h.ui.state, "idle");
  assert.equal(h.ui.arming, false);
  assert.equal(h.requests.length, 0);
  assert.equal("warming" in h.recorder, false);
  assert.equal("warm" in h.recorder, false);
});

test("click-only startup still resumes an interrupted context", async t => {
  const h = audioHarness("interrupted");
  mountToolbar(h);
  t.after(() => { clearInterval(h.ui.timer); h.recorder.stop(); h.recorder.discardContext(); });
  h.ui.button.dispatchEvent(new Event("pointerdown"));
  assert.equal(h.tracks.length, 0);
  assert.equal(h.recorder.context.resumes, 0);
  h.ui.button.dispatchEvent(new Event("click"));
  assert.equal(h.ui.arming, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.recorder.context.state, "running");
  assert.equal(h.recorder.context.resumes, 1);
  assert.equal(h.tracks.length, 1);
  assert.equal(h.recorder.active, true);
  assert.deepEqual(h.notices, []);
});

function delayedMicrophone(h) {
  const openings = [];
  let peakLive = 0;
  h.navigator.mediaDevices.getUserMedia = () => {
    const opening = deferred();
    openings.push({
      reject: opening.reject,
      resolve() {
        const track = { readyState: "live", stop() { this.readyState = "ended"; } };
        h.tracks.push(track);
        peakLive = Math.max(peakLive, h.tracks.filter(track => track.readyState === "live").length);
        opening.resolve({ getTracks: () => [track] });
      },
    });
    return opening.promise;
  };
  return { openings, get peakLive() { return peakLive; } };
}

for (const stage of ["microphone", "audio resume"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`start-cancel-start during ${stage} (${outcome}) never opens a second stream`, async t => {
      const h = audioHarness(stage === "audio resume" ? "interrupted" : "missing");
      mountToolbar(h);
      const mic = delayedMicrophone(h);
      const activation = deferred();
      if (stage === "audio resume") {
        h.recorder.context.resume = async function () { await activation.promise; this.state = "running"; };
      }
      t.after(() => { clearInterval(h.ui.timer); h.recorder.stop(); h.recorder.discardContext(); });
      const press = () => {
        h.ui.button.dispatchEvent(new Event("pointerdown"));
        h.ui.button.dispatchEvent(new Event("click"));
      };
      press();
      assert.equal(mic.openings.length, 1);
      assert.equal(h.ui.button.disabled, false, "opening can still be cancelled with a click");
      if (stage === "audio resume") { mic.openings[0].resolve(); await new Promise(resolve => setImmediate(resolve)); }
      press(); // cancel the pending opening
      assert.equal(h.ui.state, "idle");
      assert.equal(h.ui.arming, true, "keep the opening lock until cleanup has finished");
      assert.equal(h.ui.button.disabled, true);
      assert.equal(h.ui.button.attributes["aria-busy"], "true");
      assert.match(h.ui.button.title, /Cancelling microphone request/);
      h.advanceTime(1600); // past the former warm timeout
      for (let i = 0; i < 5; i += 1) press();
      h.ui.toggle(); // shortcut/headphone entry point uses the same lock
      await h.ui.start();
      assert.equal(mic.openings.length, 1);
      assert.equal(h.ui.arming, true);

      const waiting = stage === "microphone" ? mic.openings[0] : activation;
      if (outcome === "resolve") waiting.resolve();
      else waiting.reject(new Error("Late opening failure"));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.ui.state, "idle");
      assert.equal(h.ui.arming, false);
      assert.equal(h.ui.button.disabled, false);
      assert.equal(h.ui.button.attributes["aria-busy"], "false");
      assert.equal(h.recorder.active, false);
      assert.equal(h.recorder.stream, null);
      assert.ok(h.tracks.every(track => track.readyState === "ended"));
      assert.equal(h.requests.length, 0, "cancelled openings never upload audio");
      assert.deepEqual(h.notices, []);

      press(); // a genuinely new activation is now allowed
      assert.equal(mic.openings.length, 2);
      mic.openings[1].resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.recorder.active, true);
      h.recorder.chunks = [new Float32Array(128)];
      await h.ui.stop();
      assert.equal(h.requests.length, 1);
      assert.ok(h.tracks.every(track => track.readyState === "ended"));
      assert.equal(mic.peakLive, 1, "at most one live mic stream throughout the interaction");
    });
  }
}

test("microphone failure does not silently open a second stream as a fallback", async () => {
  const h = audioHarness("missing");
  mountToolbar(h);
  let calls = 0;
  h.navigator.mediaDevices.getUserMedia = async () => { calls += 1; throw new Error("Microphone unavailable"); };
  h.ui.button.dispatchEvent(new Event("pointerdown"));
  h.ui.button.dispatchEvent(new Event("click"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(h.ui.arming, false);
  assert.match(h.notices[0], /^\[Client · microphone\]/);
  assert.equal(h.requests.length, 0);
});

test("microphone wait metadata measures click-to-ready, excluding the pointer hold", async t => {
  let now = 0;
  const h = audioHarness("missing", "resolve", { now: () => now });
  mountToolbar(h);
  const mic = delayedMicrophone(h);
  t.after(() => { clearInterval(h.ui.timer); h.recorder.stop(); h.recorder.discardContext(); });
  h.ui.button.dispatchEvent(new Event("pointerdown"));
  now = 800;
  assert.equal(mic.openings.length, 0);
  h.ui.button.dispatchEvent(new Event("click"));
  now = 2000;
  mic.openings[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.ui.waitedMs, 1200);
  h.recorder.chunks = [new Float32Array(128)];
  await h.ui.stop();
  assert.equal(h.requests[0].url, "/__voice/transcribe?wait=1200");
});

test("zero samples report the pre-stop audio state and rebuild the context for the next take", async t => {
  const h = audioHarness("interrupted");
  t.after(() => { clearInterval(h.ui.timer); h.recorder.stop(); h.recorder.discardContext(); });
  h.ui.state = "recording";
  h.recorder.active = true;
  await h.ui.stop();
  assert.equal(h.requests.length, 0);
  assert.equal(h.recorder.context, null);
  assert.match(h.notices[0], /^\[Client · recording\].*nothing was uploaded.*AudioContext: interrupted/);
  assert.equal(h.contexts[0].closes, 1);
  await h.ui.start();
  assert.equal(h.contexts.length, 2);
  assert.equal(h.recorder.context.state, "running");
  assert.equal(h.recorder.active, true);
});
