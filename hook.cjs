"use strict";

/**
 * pi-web-voice — entry point for `node --require`.
 *
 * Usage:
 *   NODE_OPTIONS="--require /path/to/pi-web-voice/hook.cjs" pi-web
 *
 * The hook attaches to any HTTP server created in this process (pi-web runs
 * `next start`, which uses node:http). It does two things and nothing else:
 *
 *   1. Serves its own routes under a prefix (default `/__voice`).
 *   2. Injects one <script> tag into HTML responses.
 *
 * pi-web itself is never modified, so upgrading pi-web needs no re-apply.
 */

const { loadConfig } = require("./lib/config.cjs");
const { install } = require("./lib/patch.cjs");
const { createRouter } = require("./lib/routes.cjs");

// A single process may load the hook more than once (parent + child).
// Only the process that actually serves HTTP matters, and install() is
// idempotent, but guard anyway so logs are not duplicated.
if (!global.__PI_WEB_VOICE_INSTALLED__) {
  global.__PI_WEB_VOICE_INSTALLED__ = true;

  const config = loadConfig();

  if (config.enabled) {
    install({
      prefix: config.prefix,
      tag: `<script src="${config.prefix}/inject.js"></script>`,
      handleRoute: createRouter(config),
      onError: (error) => console.error("[pi-web-voice]", error),
      onListen: () =>
        console.log(
          `[pi-web-voice] active · provider=${config.provider} · prefix=${config.prefix}`,
        ),
    });
  }
}
