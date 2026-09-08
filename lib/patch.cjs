"use strict";

const http = require("node:http");
const { StringDecoder } = require("node:string_decoder");

/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("node:http").OutgoingHttpHeaders | import("node:http").OutgoingHttpHeader[]} ResponseHeaders */
/** @typedef {(error: unknown) => void} ErrorHandler */
/** @typedef {(error?: Error | null) => void} WriteCallback */
/** @typedef {(req: import("node:http").IncomingMessage, res: ServerResponse) => void | Promise<void>} RouteHandler */

// Bound the search for an HTML insertion point while streaming.
const MAX_BUFFERED_HTML = 1024 * 1024;

/**
 * Forward Node's overloaded calls with their receiver, arguments, and return type.
 * Reflection is confined to this bridge; each wrapper declares its input contract.
 * @template {(...args: never[]) => unknown} Method
 * @param {Method} method
 * @param {unknown} receiver
 * @param {ArrayLike<unknown>} args
 * @returns {ReturnType<Method>}
 */
function forward(method, receiver, args) {
  return /** @type {ReturnType<Method>} */ (Reflect.apply(method, receiver, args));
}

/**
 * Attach to HTTP servers through their request event, preserving installed files.
 * @param {{ prefix: string, tag: string, handleRoute: RouteHandler, onError?: ErrorHandler, onListen?: () => void }} options
 */
function install({ prefix, tag, handleRoute, onError = () => {}, onListen = () => {} }) {
  /** @type {http.Server & { __piWebVoicePatched?: boolean }} */
  const proto = http.Server.prototype;
  if (proto.__piWebVoicePatched) return;
  proto.__piWebVoicePatched = true;

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
    return forward(originalListen, this, args);
  };

  const originalEmit = proto.emit;

  /**
   * @param {string | symbol} event
   * @param {...unknown} args
   * @returns {boolean}
   */
  proto.emit = function emit(event, ...args) {
    if (event === "request") {
      // Node's request event supplies this pair; other events pass through.
      const [req, res] = /** @type {[import("node:http").IncomingMessage, ServerResponse]} */ (args);
      try {
        if (typeof req?.url === "string" && req.url.startsWith(`${prefix}/`)) {
          Promise.resolve(handleRoute(req, res)).catch((error) => {
            onError(error);
            if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
            res.end("pi-web-voice route failed");
          });
          return true;
        }

        // Ask for identity encoding and also check the actual response headers.
        delete req.headers["accept-encoding"];
        injectIntoHtml(res, tag, onError);
      } catch (error) {
        onError(error);
      }
    }
    return forward(originalEmit, this, [event, ...args]);
  };
}

/**
 * Inject one script into identity-encoded UTF-8 HTML and preserve other responses.
 * @param {ServerResponse} res
 * @param {string} tag
 * @param {ErrorHandler} onError
 */
function injectIntoHtml(res, tag, onError) {
  const originalWriteHead = res.writeHead;
  const originalWrite = res.write;
  const originalEnd = res.end;

  // done means the insertion decision is complete; UTF-8 decoding still continues.
  /** @type {"unknown" | "html" | "plain" | "done"} */
  let mode = "unknown";
  let buffered = "";
  /** @type {StringDecoder | null} */
  let decoder = null;

  /**
   * Read object or raw-array headers, retaining duplicate values for classification.
   * @param {ResponseHeaders | undefined} headers
   * @param {string} name
   * @returns {string | undefined}
   */
  function headerValue(headers, name) {
    if (!headers) return undefined;
    /** @type {import("node:http").OutgoingHttpHeader[]} */
    const values = [];
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2) {
        const key = headers[i];
        if (typeof key === "string" && key.toLowerCase() === name) values.push(headers[i + 1]);
      }
    } else {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== name) continue;
        const value = headers[key];
        if (value !== undefined) values.push(value);
      }
    }
    return values.length ? values.map(String).join(",") : undefined;
  }

  /**
   * Copy headers before removing values whose length changes during injection.
   * @param {ResponseHeaders} headers
   * @param {string} name
   * @returns {ResponseHeaders}
   */
  function stripHeader(headers, name) {
    if (Array.isArray(headers)) {
      const copy = headers.slice();
      for (let i = 0; i + 1 < copy.length;) {
        const key = copy[i];
        if (typeof key === "string" && key.toLowerCase() === name) copy.splice(i, 2);
        else i += 2;
      }
      return copy;
    }
    const copy = { ...headers };
    for (const key of Object.keys(copy)) {
      if (key.toLowerCase() === name) delete copy[key];
    }
    return copy;
  }

  /** @param {ResponseHeaders} [headersFromWriteHead] */
  function classify(headersFromWriteHead) {
    if (mode !== "unknown") return mode;
    const contentType = String(
      headerValue(headersFromWriteHead, "content-type") ?? res.getHeader("content-type") ?? "",
    );
    const contentEncoding = String(
      headerValue(headersFromWriteHead, "content-encoding") ?? res.getHeader("content-encoding") ?? "identity",
    ).trim().toLowerCase();
    const charset = /;\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1]?.toLowerCase();
    const utf8 = charset === undefined || charset === "utf-8" || charset === "utf8";
    const identity = contentEncoding === "" || contentEncoding === "identity";
    mode = contentType.split(";")[0].trim().toLowerCase() === "text/html" && utf8 && identity
      ? "html" : "plain";
    if (mode === "html") res.removeHeader("content-length");
    return mode;
  }

  /**
   * Honor Node's string encoding and retain partial UTF-8 bytes across every HTML chunk.
   * @param {unknown} chunk
   * @param {BufferEncoding} [encoding]
   */
  function asText(chunk, encoding) {
    if (chunk === null || chunk === undefined) return "";
    let bytes;
    if (typeof chunk === "string") bytes = Buffer.from(chunk, encoding);
    else if (ArrayBuffer.isView(chunk)) bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else throw new TypeError("HTML chunks must be strings or byte views");
    decoder ??= new StringDecoder("utf8");
    return decoder.write(bytes);
  }

  /** @param {string} html */
  function withTag(html) {
    // Match on the original string: case conversion can change Unicode string length.
    const head = /<\/head>/i.exec(html);
    if (head) return html.slice(0, head.index) + tag + html.slice(head.index);
    const body = /<body[^>]*>/i.exec(html);
    if (body) {
      const at = body.index + body[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
    return null;
  }

  /**
   * @param {number} status
   * @param {string | ResponseHeaders} [reasonOrHeaders]
   * @param {ResponseHeaders} [maybeHeaders]
   */
  res.writeHead = function writeHead(status, reasonOrHeaders, maybeHeaders) {
    /** @type {unknown[]} */
    const args = Array.from(arguments);
    const secondIsHeaders = reasonOrHeaders && typeof reasonOrHeaders === "object";
    const headers = secondIsHeaders ? reasonOrHeaders : maybeHeaders;
    // Snapshot once; accessor failures propagate before transformation recovery.
    const snapshot = headers ? (Array.isArray(headers) ? headers.slice() : { ...headers }) : undefined;
    if (snapshot) args[secondIsHeaders ? 1 : 2] = snapshot;
    try {
      if (classify(snapshot) === "html" && snapshot) {
        args[secondIsHeaders ? 1 : 2] = stripHeader(snapshot, "content-length");
      }
    } catch (error) {
      onError(error);
      mode = "plain";
    }
    return forward(originalWriteHead, res, args);
  };

  /**
   * @param {unknown} chunk
   * @param {BufferEncoding | WriteCallback} [encoding]
   * @param {WriteCallback} [callback]
   * @returns {boolean}
   */
  res.write = function write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    let output = chunk;
    let outputEncoding = encoding;
    try {
      const kind = classify();
      if (kind === "html") {
        buffered += asText(chunk, encoding);
        const injected = withTag(buffered);
        if (injected !== null || buffered.length > MAX_BUFFERED_HTML) {
          output = injected ?? buffered;
          outputEncoding = "utf8";
          buffered = "";
          mode = "done";
        } else {
          if (callback) process.nextTick(callback);
          return true;
        }
      } else if (kind === "done") {
        output = asText(chunk, encoding);
        outputEncoding = "utf8";
      }
    } catch (error) {
      onError(error);
      mode = "plain";
    }
    // Forward once, outside transformation recovery: native write errors propagate.
    return forward(originalWrite, res, [output, outputEncoding, callback]);
  };

  /**
   * @param {unknown} [chunk]
   * @param {BufferEncoding | (() => void)} [encoding]
   * @param {() => void} [callback]
   */
  res.end = function end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      // Node's end(callback) overload treats a function in this slot as its callback.
      callback = /** @type {() => void} */ (chunk);
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    let output = chunk;
    let outputEncoding = encoding;
    try {
      const kind = classify();
      if (kind === "html" || kind === "done") {
        const tail = buffered + asText(chunk, encoding) + (decoder ? decoder.end() : "");
        buffered = "";
        decoder = null;
        output = kind === "html" ? withTag(tail) ?? tail + tag : tail;
        outputEncoding = "utf8";
        mode = "done";
      }
    } catch (error) {
      onError(error);
      mode = "plain";
    }
    return forward(originalEnd, res, [output, outputEncoding, callback]);
  };
}

module.exports = { install };
