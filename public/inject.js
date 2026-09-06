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

  const MAX_SECONDS = 180;
  const SHORTCUT = "mod+shift+v";

  const SAMPLE_RATE = 16000;
  const BUTTON_ID = "pi-web-voice-button";

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
        empty: "没有识别到语音",
        failed: "转写失败",
        noComposer: "找不到输入框，转写结果",
      }
    : {
        idle: "Voice input — click to start, click again to stop",
        opening: "Opening the microphone — speak once the clock appears",
        recording: "Recording — click to stop",
        working: "Transcribing…",
        insecure: "Microphone needs HTTPS or localhost",
        denied: "Microphone permission denied",
        empty: "No speech detected",
        failed: "Transcription failed",
        noComposer: "No composer found; transcript",
      };

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
    // Kept for the life of the page and only suspended between takes.
    // Constructing one makes the OS open an audio session; resuming a
    // suspended one does not, so every take after the first reaches the first
    // sample sooner. The microphone stream is not kept — that is what lights
    // the recording indicator, and it is released on every stop.
    context: null,
    node: null,
    chunks: [],
    startedAt: 0,

    async start() {
      if (!window.isSecureContext) throw new Error(T.insecure);
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(T.insecure);

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!this.context) {
        this.context = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.context.state === "suspended") await this.context.resume();

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
        this.context?.suspend();
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
  const MIC_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 14.5a3.25 3.25 0 0 0 3.25-3.25v-6a3.25 3.25 0 0 0-6.5 0v6A3.25 3.25 0 0 0 12 14.5z"/><path d="M17.75 11a.85.85 0 0 0-1.7 0 4.05 4.05 0 0 1-8.1 0 .85.85 0 0 0-1.7 0 5.75 5.75 0 0 0 4.9 5.68v1.62h-1.9a.85.85 0 0 0 0 1.7h5.5a.85.85 0 0 0 0-1.7h-1.9v-1.62A5.75 5.75 0 0 0 17.75 11z"/></svg>`;

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
`;
    document.head.appendChild(style);
  }

  const ui = {
    button: null,
    state: "idle", // idle | recording | working
    timer: null,
    // True from the press until the microphone actually opens. The button is
    // already red during that window, so the state alone cannot say whether
    // there is a stream to stop.
    arming: false,
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

      // One button, one gesture: click to start, click again to stop. Going
      // through `click` rather than pointer events is what makes the keyboard,
      // VoiceOver and the accessibility API able to press it at all — none of
      // them produce pointer events.
      button.addEventListener("click", () => this.toggle());

      // A button steals focus from the composer on mousedown. Refusing that
      // default keeps the caret where it was, and on a phone keeps the
      // on-screen keyboard from collapsing under the composer.
      button.addEventListener("mousedown", (event) => event.preventDefault());

      anchor.parentElement.insertBefore(button, anchor);
      this.button = button;
      this.render();
    },

    render(extra = "") {
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

      const icon = spinning
        ? SPINNER_SVG
        : live
          ? MIC_SVG.replace("<svg ", '<svg class="pi-voice-pulse" ')
          : MIC_SVG;
      this.button.innerHTML = extra ? `${icon}<span>${extra}</span>` : icon;
    },

    toast(message, isError = true) {
      const toast = document.createElement("div");
      toast.textContent = message;
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:80px",
        "transform:translateX(-50%)",
        "z-index:99999",
        "padding:8px 14px",
        "border-radius:8px",
        "font-size:13px",
        "color:#fff",
        `background:${isError ? "#b4342c" : "#2f6f4f"}`,
        "box-shadow:0 6px 24px rgba(0,0,0,.35)",
      ].join(";");
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    },

    // Paint first, ask the microphone second. getUserMedia and the audio
    // context cost a few hundred milliseconds on a phone even when permission
    // was granted long ago, and a button that stays grey that long reads as a
    // press the page missed. What the red cannot say is that the microphone is
    // open yet, so the wait shows an ellipsis and the clock starts on the
    // first sample: no word said after the digits appear can be lost.
    async start() {
      if (this.state !== "idle" || this.arming) return;
      const pressedAt = Date.now();
      this.state = "recording";
      this.arming = true;
      this.render("…");

      try {
        await recorder.start();
      } catch (error) {
        if (this.state !== "recording") return; // already pressed again
        this.state = "idle";
        this.render();
        const denied = error?.name === "NotAllowedError";
        this.toast(denied ? T.denied : error.message || T.failed);
        return;
      } finally {
        this.arming = false;
      }

      // A second press during the wait already put the button back to idle, so
      // the stream that just opened has no owner. Close it.
      if (this.state !== "recording") {
        recorder.stop();
        return;
      }

      // Reported with the audio so the server log can show what the wait
      // actually costs on this device, rather than what it is assumed to cost.
      this.waitedMs = recorder.startedAt - pressedAt;

      // The clock counts audio, not the wait: recorder.startedAt is stamped
      // when the stream opened, so 0:00 means zero seconds of speech recorded.
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

      const wav = recorder.stop();
      this.state = "working";
      this.render();

      if (!wav) {
        this.state = "idle";
        this.render();
        this.toast(T.empty);
        return;
      }

      try {
        const query = new URLSearchParams();
        if (sessionId) query.set("session", sessionId);
        const where = currentCwd();
        if (where) query.set("cwd", where);
        if (this.waitedMs) query.set("wait", String(this.waitedMs));
        const suffix = query.toString() ? `?${query}` : "";

        const response = await nativeFetch(`${CONFIG.prefix}/transcribe${suffix}`, {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: wav,
          credentials: "include",
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || T.failed);

        const text = (result.text || "").trim();
        if (!text) {
          this.toast(T.empty);
        } else {
          // Always inserted, never sent: a wrong term is one keystroke from
          // being fixed, and Enter is right there when it is correct.
          const textarea = findComposer();
          // Never fail silently: a transcript with nowhere to go is shown
          // rather than dropped, so it can still be copied by hand.
          if (textarea) insertAtCaret(textarea, text);
          else this.toast(`${T.noComposer}: ${text}`);
        }
      } catch (error) {
        this.toast(`${T.failed}: ${error.message}`);
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
