"use strict";

const http = require("node:http");
const { StringDecoder } = require("node:string_decoder");

/**
 * Attaches to every HTTP server in this process without touching pi-web.
 *
 * `http.Server.prototype.emit` is patched rather than `http.createServer`,
 * because that catches both `createServer(handler)` and `server.on("request")`
 * styles regardless of how the framework wires things up.
 */

// Give up buffering an HTML response after this much text and flush it
// unmodified, so a pathological response can never be held in memory.
const MAX_BUFFERED_HTML = 1024 * 1024;

function install({ prefix, tag, handleRoute, onError = () => {}, onListen = () => {} }) {
  const proto = http.Server.prototype;
  if (proto.__piWebVoicePatched) return;
  proto.__piWebVoicePatched = true;

  // pi-web's launcher spawns `next start` as a child, so the hook is loaded in
  // both processes. Only the one that actually listens is interesting.
  const originalListen = proto.listen;
  let announced = false;
  proto.listen = function listen(...args) {
    if (!announced) {
      announced = true;
      try {
        onListen();
      } catch (error) {
        onError(error);
      }
    }
    return originalListen.apply(this, args);
  };

  const originalEmit = proto.emit;

  proto.emit = function emit(event, ...args) {
    if (event === "request") {
      const [req, res] = args;
      try {
        if (typeof req?.url === "string" && req.url.startsWith(`${prefix}/`)) {
          Promise.resolve(handleRoute(req, res)).catch((error) => {
            onError(error);
            if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
            res.end("pi-web-voice route failed");
          });
          return true; // handled here; upstream listeners never see it
        }

        // Identity encoding keeps HTML greppable. Loopback traffic, so the
        // extra bytes cost nothing, and the browser still gets compression
        // from any real proxy sitting in front.
        delete req.headers["accept-encoding"];

        injectIntoHtml(res, tag, onError);
      } catch (error) {
        onError(error);
      }
    }
    return originalEmit.apply(this, [event, ...args]);
  };
}

/**
 * Wraps a response so that the first `</head>` (or `<body>`) in an HTML body
 * gains one script tag. Non-HTML responses — SSE, JSON, static assets — are
 * passed straight through untouched and unbuffered.
 */
function injectIntoHtml(res, tag, onError) {
  const originalWriteHead = res.writeHead;
  const originalWrite = res.write;
  const originalEnd = res.end;

  // unknown → not yet classified, html → buffering, plain → pass through,
  // done → already injected or gave up
  let mode = "unknown";
  let buffered = "";
  let decoder = null;

  function headerValue(headers, name) {
    if (!headers || Array.isArray(headers)) return undefined;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return headers[key];
    }
    return undefined;
  }

  function dropHeader(headers, name) {
    if (!headers || Array.isArray(headers)) return;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) delete headers[key];
    }
  }

  function classify(headersFromWriteHead) {
    if (mode !== "unknown") return mode;
    const contentType =
      headerValue(headersFromWriteHead, "content-type") ?? res.getHeader("content-type");
    mode = typeof contentType === "string" && /text\/html/i.test(contentType) ? "html" : "plain";
    if (mode === "html") {
      // The body grows by the tag, and streamed HTML has no length anyway.
      res.removeHeader("content-length");
      dropHeader(headersFromWriteHead, "content-length");
    }
    return mode;
  }

  function asText(chunk) {
    if (chunk === null || chunk === undefined) return "";
    if (typeof chunk === "string") return chunk;
    if (!Buffer.isBuffer(chunk)) return String(chunk);
    // A decoder keeps multi-byte characters intact across chunk boundaries.
    decoder ??= new StringDecoder("utf8");
    return decoder.write(chunk);
  }

  function withTag(html) {
    const head = html.toLowerCase().indexOf("</head>");
    if (head >= 0) return html.slice(0, head) + tag + html.slice(head);
    const body = /<body[^>]*>/i.exec(html);
    if (body) {
      const at = body.index + body[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
    return null;
  }

  res.writeHead = function writeHead(status, reasonOrHeaders, maybeHeaders) {
    try {
      const headers =
        reasonOrHeaders && typeof reasonOrHeaders === "object" ? reasonOrHeaders : maybeHeaders;
      classify(headers);
    } catch (error) {
      onError(error);
      mode = "plain";
    }
    return originalWriteHead.apply(res, arguments);
  };

  res.write = function write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    try {
      if (classify() !== "html") return originalWrite.call(res, chunk, encoding, callback);

      buffered += asText(chunk);

      const injected = withTag(buffered);
      if (injected !== null) {
        mode = "done";
        buffered = "";
        return originalWrite.call(res, injected, "utf8", callback);
      }

      if (buffered.length > MAX_BUFFERED_HTML) {
        mode = "done";
        const flush = buffered;
        buffered = "";
        return originalWrite.call(res, flush, "utf8", callback);
      }

      if (callback) process.nextTick(callback);
      return true;
    } catch (error) {
      onError(error);
      mode = "done";
      return originalWrite.call(res, chunk, encoding, callback);
    }
  };

  res.end = function end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    try {
      if (classify() !== "html" || (mode === "done" && !buffered)) {
        return originalEnd.call(res, chunk, encoding, callback);
      }

      const tail = buffered + asText(chunk) + (decoder ? decoder.end() : "");
      buffered = "";
      mode = "done";
      // Last resort: a script appended after the markup still executes.
      const out = withTag(tail) ?? tail + tag;
      return originalEnd.call(res, out, "utf8", callback);
    } catch (error) {
      onError(error);
      return originalEnd.call(res, chunk, encoding, callback);
    }
  };
}

module.exports = { install };
