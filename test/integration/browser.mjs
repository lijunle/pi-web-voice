/**
 * Browser integration against a loopback fixture, driven by Playwright Chromium.
 * Covers recording ownership, response handling, Retry, and desktop/narrow layouts.
 * All audio is synthetic; the fixture supplies every transcription response.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { openBrowser, waitFor } from "../helpers/browser.mjs";

assert.ok(!process.env.NODE_OPTIONS, "use npm run test:integration so the installed hook is not preloaded");

const source = readFileSync(new URL("../../public/inject.js", import.meta.url));
const uploads = [];
const capturePolicies = [];
const silenceChecks = [];
const waiting = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      capturePolicies.push(url.searchParams.get("audio_context"));
      silenceChecks.push(req.headers["x-pi-voice-silence-check"]);
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

let browser;
let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  checks += 1;
  console.log(`ok  ${name}`);
}

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const driver = await openBrowser();
  browser = driver.browser;
  const { page, evaluate } = driver;
  const idle = () => waitFor(() => evaluate('window.__piWebVoice.ui.state === "idle"'), "idle UI");
  const click = async (target = "retryButton") => {
    const point = await evaluate(`(() => {
      const r=window.__piWebVoice.ui[${JSON.stringify(target)}].getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    // Native mouse input also exercises disabled buttons without Playwright
    // waiting for them to become enabled before the duplicate-click check.
    await page.mouse.click(point.x, point.y);
  };

  for (const [language, width, height] of [["en", 900, 700], ["zh-CN", 320, 568]]) {
    const captureUpload = uploads.length + 1;
    const label = language === "en" ? "Retry" : "重试";
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/?language=${language}`, { waitUntil: "domcontentloaded" });
    await waitFor(() => evaluate('!!window.__piWebVoice?.ui.button?.isConnected'), "mounted microphone");

    // Exercise click-only ownership with real Web Audio streams, but never
    // access a device. Hold getUserMedia completion to reproduce the old race.
    await evaluate(`(() => {
      window.__guardMic=navigator.mediaDevices.getUserMedia;
      window.__NativeAudioContext=window.AudioContext; window.__captureContexts=[];
      window.AudioContext=class extends window.__NativeAudioContext {
        constructor(...args){super(...args); window.__captureContexts.push(this);}
      };
      window.__openingRequests=[]; window.__sources=[]; window.__peakLive=0;
      navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{
        window.__openingRequests.push(()=>{
          const context=new window.__NativeAudioContext(), oscillator=context.createOscillator();
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
    await waitFor(() => evaluate('window.__captureContexts.length===1 && window.__captureContexts[0].state==="closed" && !window.__piWebVoice.recorder.context'), "cancelled context closure");

    await click("button"); // now a new recording is allowed
    await evaluate('window.__openingRequests[1]()');
    await waitFor(() => evaluate('window.__piWebVoice.recorder.active && window.__piWebVoice.recorder.chunks.length>0'), "real synthetic samples");
    check(`${language}: the next click captures audio with only one live stream`, await evaluate('window.__openingRequests.length===2 && window.__peakLive===1'));
    await click("button");
    await respond(captureUpload, 200, { text: "" });
    await idle();
    check(`${language}: stopping releases the stream and uploads captured audio`, uploads[captureUpload - 1].length > 44 && await evaluate('window.__sources.every(s=>s.stream.getTracks().every(t=>t.readyState==="ended")) && !window.__piWebVoice.recorder.stream'));
    await waitFor(() => evaluate('window.__captureContexts.every(c=>c.state==="closed")'), "stopped context closure");
    check(`${language}: idle retains no audio context or graph nodes`, await evaluate('window.__captureContexts.length===2 && !window.__piWebVoice.recorder.context && !window.__piWebVoice.recorder.source && !window.__piWebVoice.recorder.node && !window.__piWebVoice.recorder.mute'));

    await click("button");
    await evaluate('window.__openingRequests[2]()');
    await waitFor(() => evaluate('window.__piWebVoice.recorder.active && window.__piWebVoice.recorder.chunks.length>0'), "next take samples");
    check(`${language}: consecutive successful takes use distinct real contexts`, await evaluate('window.__captureContexts.length===3 && window.__piWebVoice.recorder.context===window.__captureContexts[2] && window.__captureContexts[1].state==="closed" && window.__peakLive===1'));
    await click("button");
    await respond(captureUpload + 1, 200, { text: "" });
    await idle();
    await waitFor(() => evaluate('window.__captureContexts.every(c=>c.state==="closed") && !window.__piWebVoice.recorder.closing'), "all capture contexts closed");
    check(`${language}: fresh-context policy accompanies both real uploads`, capturePolicies.slice(captureUpload - 1, captureUpload + 1).every(value => value === "per-take") && uploads[captureUpload].length > 44);
    await evaluate(`(async () => {
      for(const s of window.__sources){s.oscillator.stop(); await s.context.close();}
      window.__piWebVoice.recorder.discardContext(); window.__piWebVoice.ui.clearToast();
      navigator.mediaDevices.getUserMedia=window.__guardMic;
      window.AudioContext=window.__NativeAudioContext;
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
    await page.keyboard.press("Enter");
    await respond(start + 3, 200, { text: "Recovered transcript" });
    await idle();
    check(`${language}: keyboard retry recovers exactly once and clears the notice`, await evaluate(`(() => {
      const {ui,findComposer}=window.__piWebVoice;
      return findComposer().value==='Keep my draft Recovered transcript' && window.__inputs===1
        && ui.pending===null && ui.toastElement===null && ui.retryButton===null;
    })()`));
    check(`${language}: every attempt uploads identical WAV bytes`, uploads[start].length === 96044 && uploads.slice(start, start + 3).every(bytes => bytes.equals(uploads[start])));
    check(`${language}: Retry preserves the original capture-policy marker`, capturePolicies.slice(start, start + 3).every(value => value === "per-take"));
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

    const silenceStart = uploads.length;
    const beforeSilence = await evaluate('window.__piWebVoice.findComposer().value');
    await evaluate(`(() => {
      const {ui,recorder}=window.__piWebVoice;
      recorder.chunks=[new Float32Array(4*16000)];
      recorder.active=true; ui.state='recording'; void ui.stop();
    })()`);
    await respond(silenceStart + 1, 422, { code: 'silence_detected', error: 'No audible signal detected' });
    await idle();
    const anyway = language === 'en' ? 'Transcribe anyway' : '仍然转写';
    check(`${language}: a silence skip retains the WAV and gives an explicit bypass action`,
      silenceChecks[silenceStart] === undefined && await evaluate(`(() => {
        const {ui,findComposer}=window.__piWebVoice;
        return ui.pending.wav.size===128044 && ui.pending.silenceDetected===true && ui.pending.text===undefined
          && ui.retryButton.textContent===${JSON.stringify(anyway)}
          && ui.toastElement.firstElementChild.textContent.includes('HTTP 422')
          && findComposer().value===${JSON.stringify(beforeSilence)} && window.__inputs===2;
      })()`));
    check(`${language}: the bypass button retains its touch target and accessible label`, await evaluate(`(() => {
      const b=window.__piWebVoice.ui.retryButton, r=b.getBoundingClientRect();
      return r.width>=44 && r.height>=44 && r.x>=0 && r.right<=innerWidth
        && b.getAttribute('aria-label')===b.title && b.title.length>b.textContent.length;
    })()`));
    await sleep(4200);
    check(`${language}: silence retention never starts a paid request automatically`,
      uploads.length === silenceStart + 1 && await evaluate('window.__piWebVoice.ui.retryButton.isConnected'));
    await click();
    await waitFor(() => uploads.length === silenceStart + 2, 'silence bypass upload');
    await click();
    await sleep(100);
    check(`${language}: an explicit bypass is one upload with the exact retained WAV`,
      uploads.length === silenceStart + 2 && silenceChecks[silenceStart + 1] === 'bypass'
      && uploads[silenceStart + 1].equals(uploads[silenceStart])
      && await evaluate('window.__piWebVoice.ui.retryButton.disabled'));
    await respond(silenceStart + 2, 502, { error: 'Temporary upstream failure' });
    await idle();
    check(`${language}: a failed bypass retains the action for another explicit attempt`,
      await evaluate(`window.__piWebVoice.ui.retryButton.textContent===${JSON.stringify(anyway)}
        && window.__piWebVoice.ui.pending.silenceDetected && !window.__piWebVoice.ui.retryButton.disabled`));
    await evaluate('window.__piWebVoice.ui.retryButton.focus()');
    await page.keyboard.press('Enter');
    const recovered = 'Accepted.\n原样保留。';
    await respond(silenceStart + 3, 200, { text: recovered });
    await idle();
    check(`${language}: keyboard bypass preserves the returned text and clears the pending take`,
      silenceChecks[silenceStart + 2] === 'bypass' && uploads[silenceStart + 2].equals(uploads[silenceStart])
      && await evaluate(`window.__piWebVoice.findComposer().value===${JSON.stringify(beforeSilence + ' ' + recovered)}
        && window.__inputs===3 && window.__piWebVoice.ui.pending===null && window.__piWebVoice.ui.toastElement===null
        && window.__micOpens===0 && document.querySelector('.xterm-helper-textarea').value==='Leave the terminal alone'`));
    await evaluate('window.__recordTake()');
    await respond(silenceStart + 4, 200, { text: '' });
    await idle();
    check(`${language}: a new recording sends no silence bypass`, silenceChecks[silenceStart + 3] === undefined);
  }

  // Refresh is intentionally not durable storage. Assert the documented limit
  // rather than giving users a false promise that page memory survives reload.
  const last = uploads.length + 1;
  await evaluate('window.__recordTake()');
  await respond(last, 503, { error: "Pending before reload" });
  await idle();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => evaluate('!!window.__piWebVoice?.ui.button?.isConnected && window.__piWebVoice.ui.pending===null'), "fresh page");
  check("reload clears page-only audio and does not silently re-upload it", uploads.length === last && await evaluate('window.__piWebVoice.ui.retryButton===null && window.__piWebVoice.ui.toastElement===null'));
  console.log(`\n${checks}/${checks} browser integration checks passed`);
} finally {
  try { await browser?.close(); }
  finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
