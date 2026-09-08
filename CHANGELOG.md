# Changelog

## Unreleased

### Added

- Keep a failed recording in page memory so it can be resubmitted without speaking again
  or reopening the microphone. Consecutive failures retain the same WAV; only one attempt
  can run at a time, with no automatic retries.
- Offer **Retry** inside the original red error toast, alongside the complete error message.
  The final, manually accepted presentation uses white underlined text with no separate
  border or background, while retaining button semantics, keyboard focus and a minimum
  44 × 44 px touch target. English and Chinese labels are supported.
- Preserve received text if the composer is unavailable or the conversation changes.
  Retrying in the original conversation inserts cached text without another transcription.
- Ask before replacing a pending recording. Failed microphone access or a cancelled opening
  does not discard the earlier take.

### Changed

- Read transcription responses once as text before parsing JSON. Diagnose HTML, non-JSON,
  empty and malformed JSON responses without exposing browser parser exceptions such as Safari's
  “The string did not match the expected pattern.” Keep the HTTP status and the original WAV.
- Preserve structured JSON error details, including common `message`/`detail` envelopes, and
  accept valid JSON with an incorrect/missing content type. A body-read interruption remains a
  network/read error even when HTTP 502 headers were received. Empty 200/204 bodies stay retryable;
  only an explicit empty `text` field is a valid empty transcript. Raw non-JSON bodies are not
  rendered or logged; only a stable format explanation is shown.
- Make microphone capture click-only. Remove pointer-down pre-warming, its expiry timer,
  stream-claiming logic and automatic fallback opening. An abandoned pointer gesture never
  opens a microphone; each accepted activation makes one request through the same controller.
- Keep the opening guard until a cancelled request settles and its stream is released. Show a
  temporary cancelling/busy state instead of allowing rapid start-cancel-start to open a second
  stream. Healthy-context reuse, Safari recovery, keyboard access and transcription Retry remain.
- Measure `mic opened in …ms` from the accepted activation rather than finger-down. Retries keep
  the original take's wait metadata; no additional runtime logs or audio data are recorded.
- Retryable error toasts persist instead of disappearing after four seconds. Retry stays
  disabled while a request is running; another failure updates the error without stacking
  notices, and success removes both the notice and pending recording.
- Long error messages wrap and scroll so Retry remains reachable on narrow screens.
- Replace the ambiguous “No speech detected” notice with separate client-no-audio and
  server-empty-transcript messages. Client microphone/context/composer errors, network failures,
  HTTP failures and invalid server responses have distinct labels; HTTP errors retain status
  codes even for non-JSON responses. Valid request IDs are shown when the backend supplies them.
- Treat missing/non-string transcript fields as retryable invalid responses, not empty speech.
  Explicitly empty transcripts still leave the draft untouched and do not offer Retry.
  Ordinary notices still disappear after four seconds.
- Resume interrupted as well as suspended audio contexts before recording, replace closed
  contexts, and bound resume waits to three seconds. Failed activation releases the microphone;
  zero captured samples reset the context for the next take and report the pre-stop state.
  This addresses Safari lifecycle cases without claiming every failure is a cache problem.

### Documentation and verification

- Document page-memory-only retention, safe refresh/deployment, possible repeat provider
  charges, and how individual retry requests relate to metadata-only server logs.
- Cover network, HTTP and JSON failures, retained WAV data, cached-text recovery, conversation
  changes, toast lifetime, localization, action styling and replacement confirmation in unit tests.
- Cover client/server diagnostic distinctions, HTTP/JSON/schema errors, optional request IDs,
  and Safari-style interrupted, rejected, stalled and timed-out audio-context resumes. Clarify
  that the recording clock indicates graph readiness, not proof of uninterrupted sample delivery.
- Add regression coverage for click-only ownership across pointer holds, cancelled openings, audio-resume delays,
  late resolutions/rejections and another start after cleanup. Assert that live-stream count never
  exceeds one per page, and that the wait metadata excludes pointer-hold time. The isolated
  browser suite also exercises this lifecycle with real, generated Web Audio streams.
- Exercise actual `Response` bodies and failed `ReadableStream` reads in unit tests. Extend the
  browser fixture to send real HTML/plaintext/empty error bodies and to sever a TCP response after
  its HTTP 502 headers. Guard against `Response.json()` use, verify one text read per attempt, and
  recover the same WAV after all these failures without leaking raw response content.
- Check that repeated uploads receive distinct request IDs and appropriate error/success logs
  without logging audio, transcripts, credentials, session IDs, paths or upstream error bodies.
- Add `npm run test:retry`: a deterministic, self-contained headless-browser regression with
  synthetic audio and controlled local responses. It covers desktop/mobile styling, full error
  text, repeated failures, mouse/keyboard activation, duplicate clicks, identical WAV uploads,
  cleanup and refresh behaviour. It never calls a speech service.
- Run browser test commands with `NODE_OPTIONS` cleared, just like the unit suite, to avoid
  accidentally testing a separate globally installed hook.

### Limitations

- Pending audio is not written to disk and does not survive a page refresh, close or browser
  page discard. There is no recording history, download control or automatic retry loop.
- Better client response handling does not eliminate real upstream/gateway HTTP failures or
  establish the cause of a particular 502 without the corresponding request evidence.
- The runtime logging format is unchanged by the retry feature. Each uploaded attempt is a
  separate request; a cached-text insertion does not generate another service request or log.
  Client failures before an upload likewise do not create a server transcription log.
- Microphone opening is serialized within a page, not locked across different tabs. The iOS
  microphone indicator is not a count of this application's streams.
- Audio-context recovery is covered with simulated lifecycle states; the reported iPhone Safari
  problem still needs device-side confirmation after deploying the change.
