# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A README Live E2E status badge for manually triggered `main` runs, alongside CI,
  and a linked record of the successful GitHub-hosted Azure OpenAI browser check.
- GitHub Actions CI for Node 20.0.0/22/24/26 checks and Ubuntu Playwright integration
  with an explicitly installed pi-web 0.9.0 host; CI uses mock speech without service keys.
- A manually confirmed live E2E workflow scoped to the `speech-live` environment, and
  a stable-release npm publishing workflow with version validation, reusable CI,
  an `npm` environment, OIDC trusted publishing, and provenance. See
  [GitHub Actions setup](DEVELOPMENT.md#github-actions) for the external configuration.
- An explicit live `test:e2e` that drives Playwright Chromium through an isolated
  pi-web host and the configured speech service using a committed synthetic speech
  fixture. It requires recognizable text, exact draft insertion, resource cleanup,
  and no chat submission; mock configuration fails rather than masquerading as live E2E.
- Strict real-pi-web/mock integration assertions for consecutive takes, selected-range
  insertion, WAV/request metadata, cleanup, observed clock ticks, and recording limits.
  Negative unit checks reject the former smoke test's false-success conditions.
- A validated `audio_context=per-take` capture-policy marker in transcription logs,
  retained through Retry. Missing or unrecognized markers log as `unspecified` so
  older open pages and direct callers are distinguishable without logging raw input.
- Regression coverage for fresh contexts across consecutive takes, complete audio-graph
  teardown, stale callbacks, closing waits/timeouts, cancellation, and log-marker privacy.
- UTC timestamps, per-request UUIDs returned in `x-pi-voice-request-id`, and explicit
  provider, VAD, outcome, and upstream-status fields in transcription logs.
- Manual **Retry** in the persistent error notice, reusing the same recording without
  reopening the microphone or making parallel uploads.
- Recovery of cached transcripts when the composer is unavailable or the conversation
  changes, tied to the session/project captured when recording stops; confirmation
  before replacing a pending recording.
- Isolated browser retry coverage and expanded regressions for audio ownership,
  response failures, composer recovery, and metadata-only request logs.
- A concise `AGENTS.md` with documentation entry points, implementation/privacy/test
  principles, and writing rules for positive expression and present-tense prose.
- Strict TypeScript checking of the CommonJS server and CLI through JSDoc, using
  development-only TypeScript 6 and Node 20 types with a committed dependency lockfile.
  `npm run typecheck` checks types; `npm run check` also runs the unit suite. Runtime
  source remains JavaScript and the compiler emits no build artifacts.
- Regression coverage for CLI/configuration behavior, HTTP forwarding overloads,
  provider response containers, unknown exceptions, and session-record guards.

### Changed

- Upgrade all workflow pins to `actions/checkout` v7.0.1 and `actions/setup-node`
  v7.0.0, retaining full commit SHAs and the existing test, credential, and release gates.
- Organize tests into `test:unit`, `test:integration`, and opt-in `test:e2e`.
  `npm test` and `npm run check` now include server and browser integration checks;
  use Node 22.19+, pi-web on PATH, and `npx playwright install chromium` for the full
  check. Unit tests and the application retain Node 20 support.
- Replace `test:retry` and the Edge-specific CDP scripts with Playwright-driven browser
  integration using locked, development-only Playwright Chromium. Real-pi-web tests
  own temporary homes/ports, select the initial project through the UI, and preserve
  personal credentials and installed pi-web files. See [testing](DEVELOPMENT.md#test-commands-and-isolation).
- Remove cross-take AudioContext reuse: each recording creates a fresh context and
  closes it on stop, cancellation, or failure instead of suspending it between takes.
  This provides a lifecycle-isolation trial for reported iOS 26.6.1 home-screen PWA
  zero-sample failures. On 2026-09-08, the maintainer confirmed normal voice input
  after deployment; long-term recurrence testing remains open. Each take now pays
  fresh-context setup latency, included in the existing microphone-opening timing.
- Retain and disconnect all capture nodes, detach stopped processor handlers, and
  ignore stale callbacks. A new context waits for preceding closure with a bounded
  wait; failed cleanup keeps captured audio available and timed-out audio activation
  releases its microphone. See [audio lifecycle](DEVELOPMENT.md#microphone-context-and-pending-take-lifecycle).
- Azure OpenAI `gpt-transcribe` requests automatic VAD with `chunking_strategy=auto`,
  including keyword-to-prompt fallbacks, to address reproduced cases of vocabulary-biased
  text generated from silence.
- Microphone capture starts only on click. Cancelled openings remain guarded until
  cleanup finishes, preventing rapid reactivation from opening a second stream in the
  same page. Keyboard access and explicit activation remain.
- `mic opened in …ms` measures accepted activation to audio readiness instead of starting
  at pointer-down. Retry retains the original recording's timing; each upload still
  receives its own request ID. See [Transcription logs](USAGE.md#transcription-logs).
- Retryable error notices persist, keep details visible while retrying, and update
  without stacking. The underlined Retry action supports keyboard focus and touch;
  long errors wrap and scroll. Success clears the pending recording and notice.
- Client capture errors, network failures, HTTP errors, invalid responses, and explicit
  server-empty transcripts have distinct messages.
- Browser test commands clear `NODE_OPTIONS` in their child runner to avoid loading a
  separately installed hook.
- Documentation is organized into a concise README, [usage guide](USAGE.md),
  [development guide](DEVELOPMENT.md), and this changelog. Corrected configuration,
  vocabulary, and startup-log descriptions; clarified stop-time conversation binding,
  timeout and response-handling boundaries; and recorded the maintainer's iPhone Safari use.
- Reworded the guides around current behavior and positive actions, including design
  rationale and validation results. CHANGELOG remains the sole exception for historical
  and before/after narratives.

### Fixed

- Bound pending browser evaluations and response-body reads in the test harness,
  redact malformed/read-failure details, and sample the clock after mouse-down to
  avoid a false-positive clock-crossing check.
- Supervise suite process groups and temporary homes outside the child process so
  forced termination and early exit clean up host descendants and credential files.
  Validate temporary settings before file creation and preserve literal quotes.
- Require an explicit-run marker for live E2E so native Node test discovery cannot
  accidentally invoke a speech service. Block early and duplicate live-test uploads
  before server dispatch, rather than checking the count after potentially billable
  requests. Add isolated browser and process-lifecycle regressions without additional
  live speech calls.
- Require complete, correctly sized, non-silent PCM WAV data in browser round trips
  so the mock provider cannot hide silent capture or malformed encoding.
- Keep the development toolchain compatible with Node 20.0.0 by using TypeScript 6's
  JavaScript CLI, and initialize HTTP fixtures explicitly per test on that test runner.
- Reject unknown provider names, including inherited object properties, and validate
  upstream JSON containers before reading fields. Preserve text normalization within
  valid response objects and ignore malformed session records during vocabulary extraction.
- Handle ordinary errors, message-bearing objects, and primitive thrown values through
  shared message/status guards. Contain hostile getters, revoked proxies, and failed
  string conversion so error reporting still produces a retryable response.
- Validate binary upload chunks and reject stream-assembly failures through the request
  promise instead of allowing exceptions to escape asynchronous stream callbacks.
- Read project metadata from bounded JSONL headers, including long headers and EOF
  without a newline, instead of interpreting later messages or incomplete tails as metadata.
  Match complete session IDs rather than accepting a suffix from another session.
- Preserve split UTF-8 characters throughout HTML injection and search-limit fallback;
  support byte views and string encodings, and locate insertion points using original
  string indices so Unicode case folding cannot shift them.
- Support immutable object/raw-array headers while removing content length from a copy.
  Pass compressed and explicit non-UTF-8 HTML through unchanged, and propagate native
  writer errors once rather than retrying a writer that throws.
- HTML, non-JSON, empty, and malformed responses received by the browser no longer hide
  HTTP status behind parser exceptions such as Safari's “The string did not match the
  expected pattern.” The browser explains directly received non-JSON bodies without
  displaying/logging them; structured JSON error details and valid request IDs remain visible.
- Valid JSON is accepted with a missing or incorrect Content-Type. Interrupted response
  reads, empty HTTP 200/204 bodies, and missing/non-string `text` retain the recording
  for Retry. Explicitly empty transcripts leave the draft untouched without offering Retry.
- Interrupted or suspended audio contexts are resumed with a bounded wait; closed
  contexts are replaced. Failed activation releases the microphone, and zero captured
  samples reset the context for another take. See [Safari troubleshooting](USAGE.md#safari-after-backgrounding-or-switching-tabs).

### Security

- Keep upstream error bodies out of transcription service logs, logging status and
  request metadata instead while retaining detailed diagnostics for the requesting client.

## [0.1.7] - 2026-09-06

### Changed

- Increase the recording limit from three to ten minutes and the per-attempt upstream
  fetch timeout from two to ten minutes, retaining the 25 MiB upload ceiling.

### Fixed

- Keep the microphone icon and clock nodes mounted during timer updates so a clock tick
  between mouse-down and mouse-up cannot suppress the stop click.

## [0.1.6] - 2026-09-06

### Added

- An opening indicator followed by a clock and pulsing microphone when the audio graph
  is ready, plus microphone-opening latency in transcription logs.

### Changed

- Reuse the page's audio context, suspending it between recordings instead of recreating
  it for every take.
- Pre-warm the microphone on pointer-down for the click to claim, releasing unclaimed
  streams after a 1.5-second window.

### Fixed

- Paint the recording button immediately while waiting for microphone startup.
- Close a late microphone stream when the user cancels before startup finishes.

## [0.1.5] - 2026-09-06

### Changed

- Replace tap/press-and-hold recording gestures with click-to-start, click-to-stop.

### Fixed

- Allow keyboard, VoiceOver, and accessibility-generated clicks to activate the
  microphone button.
- Preserve composer focus and the mobile keyboard when pressing the button.

## [0.1.4] - 2026-09-05

### Fixed

- Find the composer near its toolbar and exclude xterm's hidden helper textarea, keeping
  transcripts out of the workspace terminal.
- Show the transcript in a notice when no composer is available instead of silently
  dropping it.

## [0.1.3] - 2026-09-03

### Fixed

- Let `doctor` finish HTTP cleanup before exiting, with a delayed fallback for keep-alive
  sockets, avoiding the Windows libuv assertion caused by immediate forced exit.

## [0.1.2] - 2026-09-03

### Fixed

- Report missing or HTTP-header-invalid API keys with the relevant environment variable
  instead of generic byte-conversion errors; add a matching `doctor` diagnosis.

## [0.1.1] - 2026-09-03

### Security

- Parse `voice.env` into a private object instead of merging its credentials into
  `process.env`, preventing file-based speech keys from being inherited by agent shell
  commands. Explicitly exported environment values still take precedence.

## [0.1.0] - 2026-09-03

### Added

- Initial Node.js hook and CLI launcher for adding voice input without modifying pi-web
  or introducing a build step.
- Browser microphone controls, 16 kHz mono PCM WAV capture, transcription progress, and
  insertion at the chat composer's caret without automatically sending the text.
- Azure AI Speech, Azure OpenAI, OpenAI-compatible, and mock backends, including
  conversation-derived vocabulary and parameter-compatibility fallbacks.
- `init` to create `~/.pi/agent/voice.env` with mode `0600`, `hook-path` for service setup,
  and `doctor` for tone/file-based backend diagnostics.
- Health and vocabulary inspection endpoints, transcription metadata logging, HTTP
  interception tests, and a headless-browser integration suite.

[Unreleased]: https://github.com/lijunle/pi-web-voice/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/lijunle/pi-web-voice/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lijunle/pi-web-voice/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lijunle/pi-web-voice/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lijunle/pi-web-voice/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lijunle/pi-web-voice/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lijunle/pi-web-voice/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lijunle/pi-web-voice/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lijunle/pi-web-voice/tree/v0.1.0
