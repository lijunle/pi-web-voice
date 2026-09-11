# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A dependency-free whole-take signal check before HTTP-route vocabulary extraction
  and provider calls. Clearly quiet 16 kHz mono PCM WAVs return HTTP 422 with
  `silence_detected`, preserving the draft and recording instead of sending silence
  with vocabulary. Unknown audio passes through; window RMS and peak limits are
  conservative signal heuristics rather than human-speech detection.
- Localized **Transcribe anyway** / **仍然转写** recovery using the same WAV and a
  one-request silence-check bypass. It retains conversation binding, explicit retries,
  and page-memory ownership while keeping the microphone closed. New takes reset the
  bypass state; successful text retains the existing exact insertion behavior.
- Metadata-only signal-gate decisions and audio levels in request logs, with an explicit
  `upstream=not-called` marker for quiet skips. See [silence check and recovery](USAGE.md#silence-check-and-recovery)
  for limitations and operation.

### Changed

- Azure OpenAI `gpt-transcribe` sends a fixed English-language dictation prompt requesting
  lightly cleaned multilingual prose in one paragraph. It asks for sentence boundaries
  based on grammar and meaning rather than pauses or audio chunks, and permits removal
  of meaningless fillers, stutters, accidental repetitions, and clearly abandoned starts.
  It preserves substantive content, languages, tone, uncertainty, and technical terms,
  keeps ambiguous wording, and treats dictated questions and instructions as content.
  The prompt accompanies structured vocabulary/language hints, applies without conversation
  vocabulary, and remains in the keyword fallback. Transcripts
  retain the provider's words and internal line breaks for user review; style adherence
  depends on the model. See [dictation style guidance](DEVELOPMENT.md#dictation-style-guidance)
  for the prompt's design references.
- Azure OpenAI `gpt-transcribe` omits `chunking_strategy` on initial and fallback
  requests for a provider-default dictation trial, instead of requesting automatic
  VAD-based chunking. Route and fallback logs report `vad=default`, without claiming
  that all internal VAD is disabled. Prompt, vocabulary, language hints, and returned
  text handling remain intact. The independent signal gate protects quiet HTTP-route
  takes; louder non-speech audio, unsupported input, direct adapter calls, and explicit
  bypasses can still produce vocabulary-biased text.

## [0.2.0] - 2026-09-08

### Added

- Manual **Retry** in a persistent error notice, resubmitting the same WAV without
  reopening the microphone or making parallel uploads. Cached transcripts support
  local recovery when the composer is unavailable or the conversation changes.
  Pending takes remain tied to the session/project captured at Stop, and starting
  another take asks for confirmation before replacement.
- UTC transcription timestamps, per-request UUIDs returned in `x-pi-voice-request-id`,
  and provider, VAD, outcome, and upstream-status fields. A validated
  `audio_context=per-take` marker survives Retry; older or unrecognized markers log
  as `unspecified`. See [transcription logs](USAGE.md#transcription-logs).
- Strict JSDoc type checking for the CommonJS server and CLI using development-only
  TypeScript 6 and Node 20 types, with a committed dependency lockfile. Runtime
  JavaScript remains dependency-free and build-free.
- Expanded unit, server integration, and Playwright browser regressions for recording
  ownership, response handling, retry, composer isolation, HTTP forwarding, provider
  contracts, session parsing, and privacy boundaries.
- GitHub Actions CI for Node 20.0.0/22/24/26 and Ubuntu browser integration with pi-web
  0.9.0; an opt-in, approval-protected E2E workflow using synthetic speech and a real
  backend; and automatic npm publishing from new stable `vX.Y.Z` tags after version
  validation and full CI. Publishing uses a tag-only `npm` environment, OIDC, and
  provenance, with no human approval. See [CI/CD setup](DEVELOPMENT.md#github-actions).
- CI and E2E README badges, a recording screenshot, a dedicated [usage guide](USAGE.md),
  [development guide](DEVELOPMENT.md), and repository guidance in `AGENTS.md`.

### Changed

- Each recording creates a fresh AudioContext and closes it on Stop, cancellation, or
  failure instead of suspending it for reuse. Context-close and activation waits are
  bounded, and microphone timing includes this setup. This isolates takes while the
  reported iOS PWA zero-sample issue remains under observation; the maintainer confirms
  normal input in the [2026-09-08 validation](DEVELOPMENT.md#manual-verification).
- Microphone acquisition starts only on explicit click/keyboard activation rather than
  pointer-down. Cancelled openings remain guarded until cleanup finishes. Opening
  latency measures accepted activation to audio readiness, excluding pointer-hold time.
- Azure OpenAI `gpt-transcribe` requests automatic VAD with scalar
  `chunking_strategy=auto`, including keyword-to-prompt fallback, to address
  vocabulary-biased text generated from silence.
- Retryable notices persist and update without stacking. Retry uses underlined text
  with keyboard focus and touch support; long messages wrap and scroll. Capture,
  network, HTTP, response-format, and successful empty-transcript outcomes have
  distinct notices.
- Tests are organized as `test:unit`, `test:integration`, and opt-in `test:e2e`.
  `npm test` and `npm run check` now include browser integration and require Node
  22.19+, pi-web on PATH, and managed Playwright Chromium. `test:integration` replaces
  `test:retry`; `test:e2e` owns its host, calls a real backend, and rejects mock rather
  than accepting an error notice as a successful round trip. Unit tests retain Node
  20 support. See [test setup](DEVELOPMENT.md#development-and-testing).
- Browser suites use locked Playwright Chromium instead of the local Edge installation
  and custom CDP transport. All test commands clear inherited `NODE_OPTIONS` to exercise
  the checkout's hook. Workflow actions use pinned checkout v7.0.1 and setup-node v7.0.0.

### Fixed

- Release all microphone tracks and retained graph nodes, discard stopped contexts,
  and ignore stale processor callbacks. Interrupted/suspended contexts use bounded
  activation; failed activation and zero-sample capture clean up for another take.
  See [Safari troubleshooting](USAGE.md#safari-after-backgrounding-or-switching-tabs).
- Read browser response text once before parsing JSON, retaining HTTP status and
  validated request IDs for HTML/plaintext, malformed/empty bodies, and read failures.
  Valid JSON works despite an incorrect or missing Content-Type. Empty HTTP 200/204
  bodies and missing/non-string `text` retain audio for Retry; explicit empty text
  preserves the draft and clears the pending take.
- Reject unknown provider names, including inherited properties, and validate upstream
  JSON containers before accessing fields while preserving documented text normalization.
- Handle primitive exceptions, hostile getters/proxies, and failed string conversion
  through shared message/status guards. Reject non-binary upload chunks and assembly
  errors through the request promise rather than escaping stream callbacks.
- Read project metadata from bounded JSONL headers, including long and EOF-terminated
  headers, and ignore malformed session records. Match complete session IDs rather
  than a suffix from another session.
- Preserve split UTF-8 throughout streamed HTML injection and search-limit fallback;
  handle byte views, string encodings, and Unicode insertion indices. Copy immutable
  object/raw-array headers when removing content length, preserve compressed and
  non-UTF-8 responses, and propagate native writer errors once with their overloads,
  callbacks, receivers, and return values intact.
- Bound test-driver evaluations and response-body reads; verify mouse clicks across an
  observed clock tick and require valid, non-silent PCM uploads and exact insertion.
  Supervise process groups and private files through timeouts, early exits, and failure.
  Keep type checking and server fixtures compatible with Node 20.0.0.

### Security

- Keep upstream error bodies out of transcription service logs, logging status and
  request metadata instead while retaining detailed diagnostics for the requesting client.
- Require explicit live-test opt-in so native test discovery cannot accidentally call
  a speech service. Block premature/duplicate live uploads and agent submissions before
  dispatch; isolate credentials in private temporary configuration and redact test
  response-read/format diagnostics.

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

[Unreleased]: https://github.com/lijunle/pi-web-voice/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lijunle/pi-web-voice/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/lijunle/pi-web-voice/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lijunle/pi-web-voice/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lijunle/pi-web-voice/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lijunle/pi-web-voice/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lijunle/pi-web-voice/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lijunle/pi-web-voice/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lijunle/pi-web-voice/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lijunle/pi-web-voice/tree/v0.1.0
