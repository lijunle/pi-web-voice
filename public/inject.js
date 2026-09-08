/**
 * pi-web-voice — browser side.
 *
 * Adds a microphone button to the pi-web composer. Recording is captured as
 * 16 kHz mono PCM WAV in the page, posted to the hook's /transcribe route, and
 * the returned text is inserted at the caret. Nothing is sent anywhere except
 * the pi-web origin you are already talking to.
 */
(() => {
  "use strict";

  const CONFIG = Object.assign(
    {
      prefix: "/__voice",
      provider: "mock",
    },
    window.__PI_WEB_VOICE__ || {},
  );

  // Ten minutes stays below the 25 MB limit of file-based Azure OpenAI
  // transcription at 16 kHz mono PCM (about 19.2 MB), while still putting a
  // finite bound on an accidentally abandoned recording.
  const MAX_SECONDS = 10 * 60;
  // How long a microphone opened at finger-down stays open unclaimed. A press
  // claims it milliseconds later; anything longer was a finger that slid off
  // the button, or a hold long enough that it can pay for its own stream.
  const WARM_MS = 1500;
  // Safari can leave resume() pending after an interruption. Do not leave the
  // user stuck at "opening" with an owned microphone indefinitely.
  const AUDIO_RESUME_MS = 3000;
  const SHORTCUT = "mod+shift+v";

  const SAMPLE_RATE = 16000;
  const BUTTON_ID = "pi-web-voice-button";
  const RETRY_BUTTON_ID = "pi-web-voice-retry";

  // ── which conversation is this tab on ────────────────────────────────────
  //
  // pi-web opens `new EventSource("/api/agent/<id>/events")` for the session it
  // is showing, so watching that call gives the exact session id — no guessing
  // from "most recent", and it follows every session switch. This runs before
  // the app's own bundle, which is why the injected tag is not deferred.

  const SESSION_URL = /\/api\/agent\/([^/?#]+)\/events/;
  let sessionId = "";
  let cwd = "";

  function noteSession(url) {
    const match = SESSION_URL.exec(String(url));
    if (match) sessionId = decodeURIComponent(match[1]);
  }

  /** The sidebar renders the working directory as a button title. */
  function currentCwd() {
    if (cwd) return cwd;
    for (const button of document.querySelectorAll("button[title]")) {
      const title = button.getAttribute("title") ?? "";
      if (/^(\/[^\s]+|[A-Za-z]:\\[^\s]+)$/.test(title)) return title;
    }
    return "";
  }

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    const Patched = function EventSource(url, ...rest) {
      noteSession(url);
      return new NativeEventSource(url, ...rest);
    };
    Patched.prototype = NativeEventSource.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSED"]) Patched[key] = NativeEventSource[key];
    window.EventSource = Patched;
  }

  // Backup: the app also POSTs to /api/agent/<id> when sending a prompt, and
  // /api/agent/new carries the working directory of a session about to exist.
  const nativeFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      const match = /\/api\/agent\/([^/?#]+)(?:$|\?)/.exec(String(url ?? ""));
      if (match && match[1] !== "new" && match[1] !== "running") {
        sessionId = decodeURIComponent(match[1]);
      }
      if (match && match[1] === "new" && typeof init?.body === "string") {
        const parsed = JSON.parse(init.body);
        if (typeof parsed.cwd === "string") cwd = parsed.cwd;
      }
    } catch {
      /* never let bookkeeping break a request */
    }
    return nativeFetch.call(this, input, init);
  };

  // pi-web ships English, Simplified Chinese and Traditional Chinese.
  const ATTACH_TITLES = ["Attach image", "附加图片", "附加圖片"];

  const zh = (navigator.language || "").toLowerCase().startsWith("zh");
  const T = zh
    ? {
        idle: "语音输入 — 点击开始，再点一次结束",
        opening: "正在打开麦克风 — 数字出现后再说话",
        recording: "正在录音 — 点击停止",
        working: "转写中…",
        insecure: "浏览器只在 HTTPS 或 localhost 下允许使用麦克风",
        denied: "麦克风权限被拒绝",
        empty: "[服务端·空结果] 音频已提交，但服务器未返回转写文字",
        captureEmpty: "[客户端·录音] 未采集到音频，未上传。请重新录音；若仍失败，请关闭并重新打开此页面",
        microphoneFailed: "[客户端·麦克风] 无法启动麦克风",
        audioFailed: "[客户端·音频] 音频上下文未能启动。请重新录音；若仍失败，请关闭并重新打开此页面",
        networkFailed: "[网络] 无法完成转写请求，录音已保留，可重试",
        responseReadFailed: "[网络] 读取服务器响应中断，录音已保留，可重试",
        invalidResponse: "[服务端响应] 转写响应格式无效，录音已保留，可重试",
        clientFailed: "[客户端] 无法处理转写结果，录音已保留，可重试",
        failed: "[服务端] 转写请求失败",
        retry: "重试",
        retryTitle: "重试转写 — 使用刚才的录音，无需重新说话",
        replaceRecording: "上一段录音还未处理成功。放弃它并开始新的录音？",
        changedSession: "[客户端·会话] 请回到录音时的会话，再点击重试",
        noComposer: "[客户端·输入框] 找不到输入框，已保留转写结果",
      }
    : {
        idle: "Voice input — click to start, click again to stop",
        opening: "Opening the microphone — speak once the clock appears",
        recording: "Recording — click to stop",
        working: "Transcribing…",
        insecure: "Microphone needs HTTPS or localhost",
        denied: "Microphone permission denied",
        empty: "[Server · empty transcript] Audio was submitted, but the server returned no transcription text",
        captureEmpty: "[Client · recording] No audio was captured; nothing was uploaded. Record again; if this persists, close and reopen this page",
        microphoneFailed: "[Client · microphone] Could not start the microphone",
        audioFailed: "[Client · audio] Audio context could not start. Record again; if this persists, close and reopen this page",
        networkFailed: "[Network] Could not complete the transcription request; recording kept for retry",
        responseReadFailed: "[Network] Could not finish reading the server response; recording kept for retry",
        invalidResponse: "[Server response] Invalid transcription response; recording kept for retry",
        clientFailed: "[Client] Could not handle the transcript; recording kept for retry",
        failed: "[Server] Transcription request failed",
        retry: "Retry",
        retryTitle: "Retry transcription — reuse the previous recording",
        replaceRecording: "The previous recording is still pending. Discard it and start a new recording?",
        changedSession: "[Client · conversation] Return to the conversation where you recorded, then retry",
        noComposer: "[Client · composer] No composer found; transcript kept",
      };

  // Expected failures already have a source-specific message. Unexpected local
  // exceptions must not be mislabeled as a speech-service failure.
  class VoiceError extends Error {}

  function responseMessage(message, response) {
    const details = [];
    if (Number.isInteger(response.status)) details.push(`HTTP ${response.status}`);
    const id = response.headers?.get?.("x-pi-voice-request-id");
    // Only display the opaque UUID, never arbitrary header content. Older
    // installations omit this header and still get the HTTP status label.
    if (typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
      details.push(`request ${id}`);
    }
    return details.length ? `${message} (${details.join(" · ")})` : message;
  }

  // ── audio ────────────────────────────────────────────────────────────────

  /** Averages a Float32 buffer down to the target rate. */
  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const output = new Float32Array(Math.round(input.length / ratio));
    for (let i = 0; i < output.length; i += 1) {
      const start = Math.round(i * ratio);
      const end = Math.min(Math.round((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      output[i] = end > start ? sum / (end - start) : 0;
    }
    return output;
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };

    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // format: PCM
    view.setUint16(22, 1, true); // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    ascii(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i += 1, offset += 2) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  const recorder = {
    active: false,
    stream: null,
    // Reused between healthy takes; failed/empty capture discards it.
    // Constructing one makes the OS open an audio session; resuming a
    // suspended one does not, so later takes normally reach samples sooner. The microphone stream is not kept — that is what lights
    // the recording indicator, and it is released on every stop.
    context: null,
    node: null,
    chunks: [],
    startedAt: 0,
    // A microphone opened at finger-down, waiting for the press to claim it.
    warming: null,

    discardContext() {
      const context = this.context;
      this.context = null;
      try { context?.close()?.catch(() => {}); } catch { /* best effort */ }
    },

    async resumeContext() {
      if (!this.context || this.context.state === "closed") {
        this.context = new (window.AudioContext || window.webkitAudioContext)();
      }
      const context = this.context;
      let timer;
      try {
        if (context.state !== "running") {
          // In particular, iOS Safari uses "interrupted" after tab switches,
          // backgrounding and audio-device interruptions, not only "suspended".
          await Promise.race([
            context.resume(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new VoiceError(T.audioFailed)), AUDIO_RESUME_MS);
            }),
          ]);
        }
        if (context.state !== "running") throw new VoiceError(T.audioFailed);
      } finally {
        clearTimeout(timer);
      }
    },

    /** Opens the microphone and the audio session, recording nothing yet. */
    async open() {
      if (!window.isSecureContext) throw new Error(T.insecure);
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(T.insecure);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      try {
        await this.resumeContext();
        return stream;
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        this.discardContext();
        throw error instanceof VoiceError ? error : new VoiceError(`${T.audioFailed}: ${error.message}`);
      }
    },

    /**
     * Asks for the microphone at finger-down, so the press only has to claim
     * it. `click` still decides whether anything is recorded, which is what
     * keeps the keyboard, VoiceOver and the accessibility API working — they
     * simply pay the whole wait.
     *
     * The recording indicator therefore lights on the press rather than on the
     * decision, and a finger that slides off the button never claims what it
     * opened. An unclaimed stream is dropped rather than left listening.
     */
    warm() {
      if (this.active || this.warming) return;
      const opening = this.open().catch(() => null); // start() reports the failure
      this.warming = opening;
      setTimeout(() => {
        if (this.warming !== opening) return; // a press claimed it
        this.warming = null;
        opening.then((stream) => stream?.getTracks().forEach((track) => track.stop()));
      }, WARM_MS);
    },

    async start() {
      // Whatever finger-down opened, or a fresh one when the press came from a
      // keyboard, a headphone squeeze, or a warm stream that timed out.
      const warmed = this.warming;
      this.warming = null;
      this.stream = (warmed && (await warmed)) || (await this.open());
      // A warmed context may have been interrupted before the click claimed it.
      if (this.context.state !== "running") await this.resumeContext();

      const source = this.context.createMediaStreamSource(this.stream);
      // ScriptProcessor is deprecated but is the only node supported by every
      // browser without shipping a separate worklet module.
      this.node = this.context.createScriptProcessor(4096, 1, 1);
      this.chunks = [];
      this.startedAt = Date.now();

      this.node.onaudioprocess = (event) => {
        if (!this.active) return;
        const input = event.inputBuffer.getChannelData(0);
        this.chunks.push(downsample(input, this.context.sampleRate, SAMPLE_RATE));
        if ((Date.now() - this.startedAt) / 1000 > MAX_SECONDS) ui.stop();
      };

      // Route through a silent gain node so the graph runs without echoing
      // the microphone back to the speakers.
      const mute = this.context.createGain();
      mute.gain.value = 0;
      source.connect(this.node);
      this.node.connect(mute);
      mute.connect(this.context.destination);

      this.active = true;
    },

    stop() {
      this.active = false;
      try {
        this.node?.disconnect();
        this.stream?.getTracks().forEach((track) => track.stop());
        this.context?.suspend()?.catch(() => {});
      } catch {
        /* teardown is best effort */
      }
      this.node = null;
      this.stream = null;

      const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of this.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.chunks = [];
      return merged.length > 0 ? encodeWav(merged, SAMPLE_RATE) : null;
    },
  };

  // ── composer ─────────────────────────────────────────────────────────────

  // "The last visible textarea" is not good enough: pi-web's workspace
  // terminal is xterm.js, which keeps a hidden IME helper textarea mounted
  // after the composer. Writing there drops the transcript at best, and at
  // worst hands it to the shell.
  function isComposerCandidate(area) {
    if (area.offsetParent === null) return false;
    if (area.classList.contains("xterm-helper-textarea")) return false;
    return !area.closest(".xterm");
  }

  function findComposer() {
    // The button was mounted next to the composer's own toolbar, so walking up
    // from it finds the right textarea even when the page holds several.
    const button = document.getElementById(BUTTON_ID);
    for (let node = button?.parentElement; node; node = node.parentElement) {
      const nearby = Array.from(node.querySelectorAll("textarea")).filter(isComposerCandidate);
      if (nearby.length) return nearby[nearby.length - 1];
    }

    const areas = Array.from(document.querySelectorAll("textarea")).filter(isComposerCandidate);
    return areas[areas.length - 1] || null;
  }

  function insertAtCaret(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const spacer = before && !/\s$/.test(before) ? " " : "";
    const next = before + spacer + text + after;

    // React tracks the previous value on the DOM node, so assigning `.value`
    // directly is ignored. Going through the prototype setter and dispatching
    // a real input event makes React pick the change up.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(textarea, next);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    const caret = before.length + spacer.length + text.length;
    textarea.setSelectionRange(caret, caret);
    textarea.focus();
  }



  // ── button ───────────────────────────────────────────────────────────────

  // A filled glyph reads as an ordinary control; the outlined one looked
  // greyed out next to pi-web's own toolbar icons.
  const MIC_SVG = `<svg class="pi-voice-mic" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 14.5a3.25 3.25 0 0 0 3.25-3.25v-6a3.25 3.25 0 0 0-6.5 0v6A3.25 3.25 0 0 0 12 14.5z"/><path d="M17.75 11a.85.85 0 0 0-1.7 0 4.05 4.05 0 0 1-8.1 0 .85.85 0 0 0-1.7 0 5.75 5.75 0 0 0 4.9 5.68v1.62h-1.9a.85.85 0 0 0 0 1.7h5.5a.85.85 0 0 0 0-1.7h-1.9v-1.62A5.75 5.75 0 0 0 17.75 11z"/></svg>`;

  const SPINNER_SVG = `<svg class="pi-voice-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>`;

  const STYLE_ID = "pi-web-voice-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
@keyframes pi-voice-spin { to { transform: rotate(360deg); } }
@keyframes pi-voice-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
.pi-voice-spin { animation: pi-voice-spin .8s linear infinite; transform-origin: 50% 50%; }
.pi-voice-pulse { animation: pi-voice-pulse 1.2s ease-in-out infinite; }
#${BUTTON_ID}:hover { background: var(--bg-hover); color: var(--text); }
#${BUTTON_ID}:active { transform: scale(.94); }
#${RETRY_BUTTON_ID} {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:44px; min-height:44px; padding:8px; box-sizing:border-box;
  appearance:none; border:0; background:transparent; box-shadow:none; color:inherit;
  font:inherit; font-weight:600; line-height:1.2; flex-shrink:0;
  text-decoration:underline; text-underline-offset:3px; text-decoration-thickness:1px;
  cursor:pointer; touch-action:manipulation;
}
#${RETRY_BUTTON_ID}:hover:not(:disabled) { text-decoration-thickness:2px; }
#${RETRY_BUTTON_ID}:focus-visible { outline:2px solid #fff; outline-offset:2px; }
#${RETRY_BUTTON_ID}:disabled { cursor:wait; opacity:.65; text-decoration:none; }
`;
    document.head.appendChild(style);
  }

  const ui = {
    button: null,
    retryButton: null,
    toastElement: null,
    toastTimer: null,
    state: "idle", // idle | recording | working
    // Keep the WAV and request context independently of any one attempt. This
    // is page memory only: retries neither reopen the mic nor write to disk.
    pending: null,
    timer: null,
    // True from the press until the microphone actually opens. The button is
    // already red during that window, so the state alone cannot say whether
    // there is a stream to stop.
    arming: false,
    // When the finger went down, if it was a finger.
    pressedAt: 0,
    // How long the last press waited for the microphone, in milliseconds.
    waitedMs: 0,

    findAnchor() {
      for (const title of ATTACH_TITLES) {
        const attach = document.querySelector(`button[title="${title}"]`);
        if (attach) return attach;
      }
      return document.querySelector(".model-selector.is-toolbar");
    },

    mount() {
      if (document.getElementById(BUTTON_ID)) return;
      const anchor = this.findAnchor();
      if (!anchor?.parentElement) return;
      ensureStyles();

      const button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.title = T.idle;
      button.setAttribute("aria-label", T.idle);
      button.style.cssText = [
        "position:relative",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "gap:4px",
        "min-width:26px",
        "height:26px",
        "padding:0 5px",
        "background:none",
        "border:none",
        "color:var(--text-muted)",
        "cursor:pointer",
        "border-radius:5px",
        "flex-shrink:0",
        // Without this the browser holds the click back while it waits to see
        // whether a second tap is coming to zoom the page. pi-web marks its own
        // icon buttons the same way.
        "touch-action:manipulation",
        "font-size:11px",
        "font-variant-numeric:tabular-nums",
        "transition:color .15s,background .15s,transform .1s",
      ].join(";");

      // Keep the hit-tested children alive for the button's whole lifetime.
      // Replacing them on every clock tick can remove the element under a
      // held mouse between mousedown and mouseup, in which case the browser
      // suppresses the click and stopping appears to require a second press.
      button.innerHTML = `${MIC_SVG}${SPINNER_SVG}<span> </span>`;

      // One button, one gesture: click to start, click again to stop. Going
      // through `click` rather than pointer events is what makes the keyboard,
      // VoiceOver and the accessibility API able to press it at all — none of
      // them produce pointer events.
      button.addEventListener("click", () => this.toggle());

      // Finger-down only opens the microphone; the click above still decides
      // what to do with it. The default is deliberately left alone here, since
      // preventing it would take the click with it.
      button.addEventListener("pointerdown", () => {
        // A pending take needs confirmation before opening another microphone.
        if (this.state !== "idle" || this.pending) return;
        this.pressedAt = Date.now();
        recorder.warm();
      });

      // A button steals focus from the composer on mousedown. Refusing that
      // default keeps the caret where it was, and on a phone keeps the
      // on-screen keyboard from collapsing under the composer.
      button.addEventListener("mousedown", (event) => event.preventDefault());

      anchor.parentElement.insertBefore(button, anchor);
      this.button = button;
      this.render();
    },

    render(extra = "") {
      this.renderToast();
      if (!this.button) return;

      const spinning = this.state === "working";
      const recording = this.state === "recording";
      // Red says the press landed; the pulse and the clock say the microphone
      // is actually open. Both change at the same instant, so there is one
      // unambiguous cue to start talking.
      const live = recording && !this.arming;

      this.button.style.color = recording
        ? "#e5534b"
        : spinning
          ? "var(--accent)"
          : "var(--text-muted)";
      this.button.style.background = recording ? "rgba(229,83,75,.12)" : "";
      this.button.title = live
        ? T.recording
        : recording
          ? T.opening
          : spinning
            ? T.working
            : T.idle;
      this.button.setAttribute("aria-label", this.button.title);
      this.button.setAttribute("aria-busy", spinning ? "true" : "false");

      // Only change properties of the mounted children. In particular, the
      // clock updates must not replace the span or SVG under a mouse press.
      const mic = this.button.querySelector(".pi-voice-mic");
      const spinner = this.button.querySelector(".pi-voice-spin");
      const label = this.button.querySelector("span");
      mic.classList.toggle("pi-voice-pulse", live);
      mic.style.display = spinning ? "none" : "";
      spinner.style.display = spinning ? "" : "none";
      // Keep the Text node too: assigning textContent would replace it, and
      // Chromium includes that internal text hit in its click-target check.
      label.firstChild.nodeValue = extra;
      label.style.display = extra ? "" : "none";
    },

    clearToast() {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
      this.toastElement?.remove();
      this.toastElement = null;
      this.retryButton = null;
    },

    renderToast() {
      if (!this.retryButton) return;
      if (!this.pending) return this.clearToast();
      const working = this.state === "working";
      this.retryButton.disabled = this.state !== "idle" || this.arming;
      this.retryButton.textContent = working ? T.working : T.retry;
      this.retryButton.setAttribute("aria-busy", working ? "true" : "false");
    },

    toast(message, isError = true, retryable = false) {
      // One notice at a time. A failed retry updates the red notice instead of
      // stacking another over it, and an older timer cannot dismiss it.
      this.clearToast();
      ensureStyles();
      const toast = document.createElement("div");
      toast.setAttribute("role", isError ? "alert" : "status");
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:80px",
        "transform:translateX(-50%)",
        "z-index:99999",
        "display:flex",
        "align-items:center",
        "gap:12px",
        "width:max-content",
        "max-width:calc(100vw - 32px)",
        "box-sizing:border-box",
        "padding:8px 14px",
        "border-radius:8px",
        "font-size:13px",
        "color:#fff",
        `background:${isError ? "#b4342c" : "#2f6f4f"}`,
        "box-shadow:0 6px 24px rgba(0,0,0,.35)",
      ].join(";");
      const content = document.createElement("span");
      content.textContent = message;
      // Long provider errors must wrap/scroll, not push Retry off a phone's
      // screen. The action stays outside that scrollable text region.
      content.style.cssText = "min-width:0;overflow-wrap:anywhere;max-height:40vh;overflow:auto";
      toast.appendChild(content);
      if (retryable && this.pending) {
        const retry = document.createElement("button");
        retry.id = RETRY_BUTTON_ID;
        retry.type = "button";
        retry.title = T.retryTitle;
        retry.setAttribute("aria-label", T.retryTitle);
        retry.addEventListener("click", () => this.retry());
        retry.addEventListener("mousedown", (event) => event.preventDefault());
        toast.appendChild(retry);
        this.retryButton = retry;
      } else {
        this.toastTimer = setTimeout(() => this.clearToast(), 4000);
      }
      this.toastElement = toast;
      document.body.appendChild(toast);
      this.renderToast();
    },

    // Paint first, ask the microphone second. getUserMedia and the audio
    // context cost a few hundred milliseconds on a phone even when permission
    // was granted long ago, and a button that stays grey that long reads as a
    // press the page missed. What the red cannot say is that the microphone is
    // open yet, so the wait shows an ellipsis and the clock starts once the
    // audio graph is ready. Interruptions can still prevent sample delivery.
    async start() {
      if (this.state !== "idle" || this.arming) return;
      if (this.pending && !window.confirm(T.replaceRecording)) return;
      // Timed from finger-down when there was one: that is when the microphone
      // was asked for, and when the user started waiting. A stale press with no
      // click behind it is ignored.
      const pressedAt = Date.now() - this.pressedAt < WARM_MS ? this.pressedAt : Date.now();
      this.state = "recording";
      this.arming = true;
      this.render("…");

      try {
        await recorder.start();
      } catch (error) {
        recorder.stop();
        recorder.discardContext();
        if (this.state !== "recording") return; // already pressed again
        this.state = "idle";
        const denied = error?.name === "NotAllowedError";
        const message = error instanceof VoiceError
          ? error.message
          : `${T.microphoneFailed}: ${denied ? T.denied : error.message}`;
        this.toast(message, true, !!this.pending);
        return;
      } finally {
        this.arming = false;
        if (this.state === "idle") this.render();
      }

      // A second press during the wait already put the button back to idle, so
      // the stream that just opened has no owner. Close it.
      if (this.state !== "recording") {
        recorder.stop();
        return;
      }

      // Do not lose the previous take to a denied permission or a cancelled
      // microphone opening, even after the user agreed to replace it.
      this.pending = null;

      // Reported with the audio so the server log can show what the wait
      // actually costs on this device, rather than what it is assumed to cost.
      this.waitedMs = recorder.startedAt - pressedAt;

      // Count time since the stream/graph opened, excluding microphone wait.
      // The clock is a readiness cue, not a sample-delivery monitor.
      this.render("0:00");
      this.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - recorder.startedAt) / 1000);
        this.render(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
      }, 250);
    },

    async stop() {
      if (this.state !== "recording") return;
      clearInterval(this.timer);

      // Pressed again before the microphone opened. There is no audio to send,
      // and start() closes the stream when it finally arrives.
      if (this.arming) {
        this.state = "idle";
        this.render();
        return;
      }

      const audioState = recorder.context?.state || "none";
      const wav = recorder.stop();
      this.state = "idle";
      if (!wav) {
        // A running-but-stalled Safari context can also yield no callbacks.
        // Recreate it on the next take rather than requiring a page reload.
        recorder.discardContext();
        this.render();
        this.toast(`${T.captureEmpty} (AudioContext: ${audioState})`);
        return;
      }

      const query = new URLSearchParams();
      if (sessionId) query.set("session", sessionId);
      const where = currentCwd();
      if (where) query.set("cwd", where);
      if (this.waitedMs) query.set("wait", String(this.waitedMs));
      const suffix = query.toString() ? `?${query}` : "";
      this.pending = { wav, url: `${CONFIG.prefix}/transcribe${suffix}`, sessionId, cwd: where };
      return this.retry();
    },

    async retry() {
      if (this.state !== "idle" || this.arming || !this.pending) return;
      const take = this.pending;
      const sameSession = () => take.sessionId === sessionId && take.cwd === currentCwd();
      this.state = "working";
      this.render();

      try {
        if (!sameSession()) throw new VoiceError(T.changedSession);
        if (take.text === undefined) {
          let response;
          try {
            response = await nativeFetch(take.url, {
              method: "POST",
              headers: { "content-type": "audio/wav" },
              body: take.wav,
              credentials: "include",
            });
          } catch (error) {
            throw new VoiceError(`${T.networkFailed}: ${error.message}`);
          }
          let result;
          try {
            result = await response.json();
          } catch (error) {
            const message = !response.ok ? T.failed
              : error?.name === "SyntaxError" ? T.invalidResponse : T.responseReadFailed;
            throw new VoiceError(`${responseMessage(message, response)}: ${error.message}`);
          }
          if (!response.ok) {
            const detail = typeof result?.error === "string" ? result.error : result?.error?.message;
            throw new VoiceError(`${responseMessage(T.failed, response)}${detail ? `: ${detail}` : ""}`);
          }
          // A missing/malformed text field is not a successful empty transcript.
          if (typeof result?.text !== "string") {
            throw new VoiceError(responseMessage(T.invalidResponse, response));
          }
          take.text = result.text.trim();
          take.emptyMessage = responseMessage(T.empty, response);
        }

        // An explicit empty string is a server result, not proof that the
        // browser captured no audio or that the user did not speak.
        if (!take.text) {
          this.toast(take.emptyMessage);
        } else {
          // The user may have changed conversations while the request ran.
          // Keep the text as well as the WAV so returning and retrying inserts
          // it without paying for another transcription.
          if (!sameSession()) throw new VoiceError(T.changedSession);
          const textarea = findComposer();
          if (!textarea) {
            this.toast(`${T.noComposer}: ${take.text}`, true, true);
            return;
          }
          // Always inserted, never sent.
          insertAtCaret(textarea, take.text);
        }
        this.pending = null;
      } catch (error) {
        const message = error instanceof VoiceError ? error.message : `${T.clientFailed}: ${error.message}`;
        this.toast(message, true, true);
      } finally {
        this.state = "idle";
        this.render();
      }
    },

    toggle() {
      if (this.state === "recording") this.stop();
      else if (this.state === "idle") this.start();
    },
  };

  // ── wiring ───────────────────────────────────────────────────────────────

  function matchesShortcut(event) {
    const parts = SHORTCUT.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const wantMod = parts.includes("mod");
    const wantShift = parts.includes("shift");
    const wantAlt = parts.includes("alt");
    const mod = event.metaKey || event.ctrlKey;
    return (
      event.key.toLowerCase() === key &&
      mod === wantMod &&
      event.shiftKey === wantShift &&
      event.altKey === wantAlt
    );
  }

  document.addEventListener("keydown", (event) => {
    if (!matchesShortcut(event)) return;
    event.preventDefault();
    ui.toggle();
  });

  if ("mediaSession" in navigator) {
    // Headphone play/pause — a squeeze on AirPods starts and stops recording.
    try {
      navigator.mediaSession.setActionHandler("play", () => ui.toggle());
      navigator.mediaSession.setActionHandler("pause", () => ui.toggle());
    } catch {
      /* not supported here */
    }
  }

  // pi-web re-renders the composer on session switches, so keep re-mounting.
  const observer = new MutationObserver(() => ui.mount());
  const boot = () => {
    ui.mount();
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.__piWebVoice = {
    ui,
    recorder,
    config: CONFIG,
    findComposer,
    get sessionId() {
      return sessionId;
    },
    get cwd() {
      return currentCwd();
    },
  };
})();
