# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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

### Changed

- Azure OpenAI `gpt-transcribe` requests automatic VAD with `chunking_strategy=auto`,
  including keyword-to-prompt fallbacks, to address reproduced cases of vocabulary-biased
  text generated from silence.
- Microphone capture starts only on click. Cancelled openings remain guarded until
  cleanup finishes, preventing rapid reactivation from opening a second stream in the
  same page. Healthy audio-context reuse and keyboard access remain.
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
