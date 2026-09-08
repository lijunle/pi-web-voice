/**
 * Offline browser regression for the accepted Retry toast.
 *
 *   npm run test:retry
 *
 * Requires Node 22+ and Edge (or BROWSER pointing to another Chromium binary).
 * Starts its own loopback fixture and isolated headless browser. No pi-web,
 * microphone permissions, credentials or speech service are used.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.equal(typeof WebSocket, "function", "browser tests require Node 22+ (global WebSocket)");
assert.ok(!process.env.NODE_OPTIONS, "use npm run test:retry so the installed hook is not preloaded");

const source = readFileSync(new URL("../public/inject.js", import.meta.url));
const uploads = [];
const waiting = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

// Responses are held until the test releases them, so working/disabled states
// and duplicate clicks are checked without racing a fast or slow speech API.
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/inject.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end(source);
    }
    if (url.pathname === "/__voice/transcribe" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      uploads.push(Buffer.concat(chunks));
      waiting.set(uploads.length, res);
      return;
    }
    if (url.pathname !== "/") { res.writeHead(404); return res.end(); }
    const language = url.searchParams.get("language") === "zh-CN" ? "zh-CN" : "en";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Voice retry test</title><style>
      :root { --bg-hover:#333; --text:#eee; --text-muted:#aaa; --accent:#8bb9ff;
        color:#eee; background:#191919; font:14px system-ui; }
      main { max-width:640px; margin:24px auto; padding:8px; }
      textarea { box-sizing:border-box; width:100%; height:100px; }
      .toolbar { display:flex; gap:4px; }
      </style><script>
      Object.defineProperty(navigator, 'language', {value:${JSON.stringify(language)}});
      window.__micOpens=0;
      navigator.mediaDevices.getUserMedia=async()=>{ window.__micOpens++; throw Error('No microphone in this test'); };
      </script><script src="/inject.js"></script></head><body><main>
      <textarea>Keep my draft</textarea><div class="toolbar"><button title="Attach image">Attach</button></div>
      </main><div class="xterm"><textarea class="xterm-helper-textarea">Leave the terminal alone</textarea></div>
      </body></html>`);
  } catch (error) {
    if (!res.destroyed) { res.writeHead(500); res.end(error.message); }
  }
});
async function takeResponse(index) {
  await waitFor(() => waiting.has(index), `upload ${index}`);
  const res = waiting.get(index);
  waiting.delete(index);
  return res;
}
async function respondRaw(index, status, body, type) {
  const res = await takeResponse(index);
  res.writeHead(status, type ? { "content-type": type } : {});
  res.end(body);
}
async function respond(index, status, body) {
  await respondRaw(index, status, JSON.stringify(body), "application/json");
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Browser connection closed"));
    }
    pending.clear();
  });
  return {
    ready,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timed out: ${method}`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
  };
}

let browser, cdp, profile;
let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  checks += 1;
  console.log(`ok  ${name}`);
}

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  profile = mkdtempSync(join(tmpdir(), "pi-web-voice-retry-"));
  browser = spawn(process.env.BROWSER || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--autoplay-policy=no-user-gesture-required", // synthetic Web Audio input, never a device microphone
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, origin,
  ], { stdio: "ignore" });
  let startupError;
  browser.on("error", error => { startupError = error; });
  let port;
  await waitFor(() => {
    if (startupError) throw startupError;
    if (browser.exitCode !== null) throw new Error(`Browser exited with ${browser.exitCode}`);
    try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return port > 0;
  }, "browser debugging port");
  let page;
  await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = pages.find(entry => entry.type === "page" && entry.url.startsWith(origin));
    return page?.webSocketDebuggerUrl;
  }, "fixture page");
  cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const evaluate = async expression => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "Browser evaluation failed");
    return result.value;
  };
  const idle = () => waitFor(() => evaluate('window.__piWebVoice.ui.state === "idle"'), "idle UI");
  const click = async (target = "retryButton") => {
    const point = await evaluate(`(() => {
      const r=window.__piWebVoice.ui[${JSON.stringify(target)}].getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { ...point, type: "mousePressed", button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { ...point, type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 });
  };

  for (const [language, width, height] of [["en", 900, 700], ["zh-CN", 320, 568]]) {
    const captureUpload = uploads.length + 1;
    const label = language === "en" ? "Retry" : "重试";
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 400 });
    await cdp.send("Page.navigate", { url: `${origin}/?language=${language}` });
    await waitFor(() => evaluate('!!window.__piWebVoice?.ui.button?.isConnected'), "mounted microphone");

    // Exercise click-only ownership with real Web Audio streams, but never
    // access a device. Hold getUserMedia completion to reproduce the old race.
    await evaluate(`(() => {
      window.__guardMic=navigator.mediaDevices.getUserMedia;
      window.__openingRequests=[]; window.__sources=[]; window.__peakLive=0;
      navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{
        window.__openingRequests.push(()=>{
          const context=new AudioContext(), oscillator=context.createOscillator();
          const destination=context.createMediaStreamDestination();
          oscillator.connect(destination); oscillator.start();
          window.__sources.push({context,oscillator,stream:destination.stream});
          const live=window.__sources.flatMap(s=>s.stream.getTracks()).filter(t=>t.readyState==='live').length;
          window.__peakLive=Math.max(window.__peakLive,live);
          resolve(destination.stream);
        });
      });
      window.__piWebVoice.ui.button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    })()`);
    await sleep(1600);
    check(`${language}: a pointer hold never requests microphone access`, await evaluate('window.__openingRequests.length===0 && window.__piWebVoice.ui.state==="idle"'));
    await click("button"); // begin an opening
    await click("button"); // cancel it
    for (let i = 0; i < 3; i += 1) await click("button");
    check(`${language}: repeated start-cancel-start keeps just one pending opening`, await evaluate('window.__openingRequests.length===1 && window.__piWebVoice.ui.arming && window.__piWebVoice.ui.state==="idle" && window.__piWebVoice.ui.button.disabled && window.__piWebVoice.ui.button.getAttribute("aria-busy")==="true"'));
    await evaluate('window.__openingRequests[0]()');
    await waitFor(() => evaluate('!window.__piWebVoice.ui.arming'), "cancelled opening cleanup");
    check(`${language}: a cancelled late stream is closed without uploading`, uploads.length === captureUpload - 1 && await evaluate('window.__sources[0].stream.getTracks().every(t=>t.readyState==="ended") && !window.__piWebVoice.recorder.active && !window.__piWebVoice.recorder.stream'));

    await click("button"); // now a new recording is allowed
    await evaluate('window.__openingRequests[1]()');
    await waitFor(() => evaluate('window.__piWebVoice.recorder.active && window.__piWebVoice.recorder.chunks.length>0'), "real synthetic samples");
    check(`${language}: the next click captures audio with only one live stream`, await evaluate('window.__openingRequests.length===2 && window.__peakLive===1'));
    await click("button");
    await respond(captureUpload, 200, { text: "" });
    await idle();
    check(`${language}: stopping releases the stream and uploads captured audio`, uploads[captureUpload - 1].length > 44 && await evaluate('window.__sources.every(s=>s.stream.getTracks().every(t=>t.readyState==="ended")) && !window.__piWebVoice.recorder.stream'));
    await evaluate(`(async () => {
      for(const s of window.__sources){s.oscillator.stop(); await s.context.close();}
      window.__piWebVoice.recorder.discardContext(); window.__piWebVoice.ui.clearToast();
      navigator.mediaDevices.getUserMedia=window.__guardMic;
    })()`);

    const start = uploads.length;
    await evaluate(`(() => {
      const area=window.__piWebVoice.findComposer();
      area.focus(); area.setSelectionRange(area.value.length,area.value.length);
      window.__inputs=0; area.addEventListener('input',()=>window.__inputs++);
      window.__recordTake=()=>{
        const {ui,recorder}=window.__piWebVoice;
        recorder.chunks=[Float32Array.from({length:48000},(_,i)=>Math.sin(i/15)*.2)];
        recorder.active=true; ui.state='recording'; void ui.stop();
      };
      window.__recordTake();
    })()`);
    await respond(start + 1, 503, { error: "Temporary service failure" });
    await idle();
    const appearance = await evaluate(`(() => {
      const {ui}=window.__piWebVoice, b=ui.retryButton, css=getComputedStyle(b), r=b.getBoundingClientRect();
      return {label:b.textContent,tag:b.tagName,type:b.type,border:css.borderWidth,background:css.backgroundColor,
        color:css.color,decoration:css.textDecorationLine,width:r.width,height:r.height,
        error:ui.toastElement.firstElementChild.textContent,red:getComputedStyle(ui.toastElement).backgroundColor,
        inline:b.parentElement===ui.toastElement,toolbar:!!b.closest('.toolbar')};
    })()`);
    check(`${language}: Retry is an inline button with link appearance`, appearance.label === label && appearance.tag === "BUTTON" && appearance.type === "button" && appearance.inline && !appearance.toolbar);
    check(`${language}: white underlined text, no border or background`, appearance.color === "rgb(255, 255, 255)" && appearance.decoration === "underline" && appearance.border === "0px" && appearance.background === "rgba(0, 0, 0, 0)");
    check(`${language}: touch target stays at least 44 × 44`, appearance.width >= 44 && appearance.height >= 44);
    check(`${language}: original red notice identifies the HTTP failure and keeps full details`, appearance.red === "rgb(180, 52, 44)" && appearance.error.startsWith(language === "en" ? "[Server]" : "[服务端]") && appearance.error.includes("HTTP 503") && appearance.error.endsWith("Temporary service failure"));
    await sleep(4200);
    check(`${language}: error and Retry outlive the old four-second timeout`, await evaluate('window.__piWebVoice.ui.toastElement.isConnected && !window.__piWebVoice.ui.retryButton.disabled'));

    await click();
    await waitFor(() => uploads.length === start + 2, "retry upload");
    check(`${language}: pending retry disables action without hiding the error`, await evaluate(`(() => {
      const {ui}=window.__piWebVoice;
      return ui.state==='working' && ui.retryButton.disabled && ui.retryButton.getAttribute('aria-busy')==='true'
        && getComputedStyle(ui.retryButton).textDecorationLine==='none'
        && ui.toastElement.firstElementChild.textContent.endsWith('Temporary service failure');
    })()`));
    await click();
    await sleep(150);
    check(`${language}: repeated clicks cannot upload in parallel`, uploads.length === start + 2);
    const longError = '503 <img src=x onerror="window.__errorHtmlRan=true"> ' + "provider-detail/".repeat(250);
    await respond(start + 2, 503, { error: longError });
    await idle();
    check(`${language}: failed retry keeps full error as text, without stacked notices`, await evaluate(`(() => {
      const {ui}=window.__piWebVoice;
      return ui.toastElement.firstElementChild.textContent.endsWith(${JSON.stringify(longError)})
        && !window.__errorHtmlRan && document.querySelectorAll('[role=alert]').length===1;
    })()`));
    check(`${language}: long errors scroll without pushing Retry off screen`, await evaluate(`(() => {
      const {ui}=window.__piWebVoice, text=ui.toastElement.firstElementChild, r=ui.retryButton.getBoundingClientRect();
      return text.scrollHeight>text.clientHeight && r.x>=0 && r.right<=innerWidth && r.y>=0 && r.bottom<=innerHeight;
    })()`));
    await evaluate('window.__oldRetry=window.__piWebVoice.ui.retryButton; window.__piWebVoice.ui.button.remove()');
    await waitFor(() => evaluate('window.__piWebVoice.ui.button.isConnected'), "composer re-mount");
    check(`${language}: composer re-mount leaves the Retry action intact`, await evaluate('window.__oldRetry===window.__piWebVoice.ui.retryButton && window.__oldRetry.isConnected'));
    await evaluate('window.__piWebVoice.ui.retryButton.focus()');
    assert.ok(await evaluate('document.activeElement===window.__piWebVoice.ui.retryButton'));
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r",
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await respond(start + 3, 200, { text: "Recovered transcript" });
    await idle();
    check(`${language}: keyboard retry recovers exactly once and clears the notice`, await evaluate(`(() => {
      const {ui,findComposer}=window.__piWebVoice;
      return findComposer().value==='Keep my draft Recovered transcript' && window.__inputs===1
        && ui.pending===null && ui.toastElement===null && ui.retryButton===null;
    })()`));
    check(`${language}: every attempt uploads identical WAV bytes`, uploads[start].length === 96044 && uploads.slice(start, start + 3).every(bytes => bytes.equals(uploads[start])));
    check(`${language}: retry leaves the microphone closed and terminal text untouched`, await evaluate('window.__micOpens===0 && !window.__piWebVoice.recorder.stream && document.querySelector(".xterm-helper-textarea").value==="Leave the terminal alone"'));

    const localMessage = await evaluate(`(async () => {
      const {ui,recorder}=window.__piWebVoice;
      recorder.chunks=[]; recorder.active=true; ui.state='recording'; await ui.stop();
      return ui.toastElement.firstElementChild.textContent;
    })()`);
    check(`${language}: zero samples are labeled client-side and never uploaded`, uploads.length === start + 3 && localMessage.startsWith(language === "en" ? "[Client · recording]" : "[客户端·录音]") && localMessage.includes("AudioContext: none"));
    await evaluate('window.__recordTake()');
    await respond(start + 4, 200, { text: "" });
    await idle();
    const emptyMessage = await evaluate('window.__piWebVoice.ui.toastElement.firstElementChild.textContent');
    check(`${language}: server empty text has a different label and HTTP status`, emptyMessage.startsWith(language === "en" ? "[Server · empty transcript]" : "[服务端·空结果]") && emptyMessage.includes("HTTP 200") && await evaluate('window.__piWebVoice.ui.pending===null && window.__piWebVoice.ui.retryButton===null'));

    // Real error bytes, not a JSON object whose error field contains HTML.
    // Guard the Safari-specific API too: the handler must read text once and
    // never depend on Response.json()'s browser-specific exception message.
    const gatewayStart = uploads.length;
    await evaluate(`(() => {
      window.__originalText=Response.prototype.text; window.__originalJson=Response.prototype.json;
      window.__textReads=0; window.__jsonReads=0;
      Response.prototype.text=function(){window.__textReads++; return window.__originalText.call(this);};
      Response.prototype.json=function(){
        window.__jsonReads++;
        return Promise.reject(new DOMException('The string did not match the expected pattern.','SyntaxError'));
      };
      window.__recordTake(); window.__gatewayWav=window.__piWebVoice.ui.pending.wav;
    })()`);
    const cases = [
      [502, 'text/html', '<!doctype html><html>PRIVATE_RAW_BODY<script>window.__rawHtmlRan=true</script></html>', 'HTML instead of JSON', 'HTML，而不是 JSON'],
      [502, 'text/plain', 'PRIVATE_RAW_BODY upstream unavailable', 'non-JSON response', '非 JSON 响应'],
      [502, 'text/plain', '', 'empty response', '空响应'],
      [200, 'application/json', '{"text":"PRIVATE_RAW_BODY', 'invalid or incomplete JSON', '无效或不完整的 JSON'],
      [200, 'application/json', '', 'empty response', '空响应'],
    ];
    for (let index = 0; index < cases.length; index++) {
      if (index) await click();
      const [status, type, body, english, chinese] = cases[index];
      await respondRaw(gatewayStart + index + 1, status, body, type);
      await idle();
      const notice = await evaluate('window.__piWebVoice.ui.toastElement.firstElementChild.textContent');
      const prefix = language === 'en' ? (status === 200 ? '[Server response]' : '[Server]')
        : (status === 200 ? '[服务端响应]' : '[服务端]');
      check(`${language}: actual ${body ? type : "empty body"} / HTTP ${status} is diagnosed without leaking its body`,
        notice.startsWith(prefix) && notice.includes(`HTTP ${status}`) && notice.includes(language === 'en' ? english : chinese)
        && !/PRIVATE_RAW_BODY|expected pattern|Unexpected/.test(notice)
        && await evaluate('!window.__rawHtmlRan && window.__piWebVoice.ui.pending.wav===window.__gatewayWav && !window.__piWebVoice.ui.retryButton.disabled && window.__inputs===1'));
    }

    await click();
    const broken = await takeResponse(gatewayStart + cases.length + 1);
    broken.writeHead(502, { 'content-type': 'application/json', 'content-length': '4096', connection: 'close' });
    broken.flushHeaders();
    broken.write('{"error":"PRIVATE_RAW_BODY');
    await waitFor(() => evaluate(`window.__textReads===${cases.length + 1}`), 'response body reader');
    broken.destroy(); // headers received, but the body never finishes
    await idle();
    const interrupted = await evaluate('window.__piWebVoice.ui.toastElement.firstElementChild.textContent');
    check(`${language}: interrupted 502 body is a read/network error with its HTTP status intact`,
      interrupted.startsWith(language === 'en' ? '[Network]' : '[网络]') && interrupted.includes('HTTP 502')
      && !/PRIVATE_RAW_BODY|expected pattern|Unexpected/.test(interrupted)
      && await evaluate('window.__piWebVoice.ui.pending.wav===window.__gatewayWav && !window.__piWebVoice.ui.retryButton.disabled'));

    await click();
    await respond(gatewayStart + cases.length + 2, 200, { text: 'Recovered after gateway failure' });
    await idle();
    check(`${language}: gateway failures recover once using the original audio, without Response.json`,
      uploads.slice(gatewayStart).every(bytes => bytes.equals(uploads[gatewayStart]))
      && await evaluate(`window.__textReads===${cases.length + 2} && window.__jsonReads===0 && window.__inputs===2
        && window.__piWebVoice.findComposer().value==='Keep my draft Recovered transcript Recovered after gateway failure'
        && window.__piWebVoice.ui.pending===null && window.__piWebVoice.ui.toastElement===null && window.__micOpens===0`));
    await evaluate('Response.prototype.text=window.__originalText; Response.prototype.json=window.__originalJson');
  }

  // Refresh is intentionally not durable storage. Assert the documented limit
  // rather than giving users a false promise that page memory survives reload.
  const last = uploads.length + 1;
  await evaluate('window.__recordTake()');
  await respond(last, 503, { error: "Pending before reload" });
  await idle();
  await cdp.send("Page.reload");
  await waitFor(() => evaluate('!!window.__piWebVoice?.ui.button?.isConnected && window.__piWebVoice.ui.pending===null'), "fresh page");
  check("reload clears page-only audio and does not silently re-upload it", uploads.length === last && await evaluate('window.__piWebVoice.ui.retryButton===null && window.__piWebVoice.ui.toastElement===null'));
  console.log(`\n${checks}/${checks} browser retry checks passed`);
} finally {
  cdp?.close();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise(resolve => browser.once("exit", resolve));
    browser.kill();
    const timer = setTimeout(() => browser.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (profile) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { console.warn("Temporary browser profile could not be removed"); }
  }
}
