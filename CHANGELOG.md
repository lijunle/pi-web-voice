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

- Retryable error toasts persist instead of disappearing after four seconds. Retry stays
  disabled while a request is running; another failure updates the error without stacking
  notices, and success removes both the notice and pending recording.
- Long error messages wrap and scroll so Retry remains reachable on narrow screens.
- Successful empty transcripts retain the existing “No speech detected” behaviour and do not
  offer Retry. Ordinary notices still disappear after four seconds.

### Documentation and verification

- Document page-memory-only retention, safe refresh/deployment, possible repeat provider
  charges, and how individual retry requests relate to metadata-only server logs.
- Cover network, HTTP and JSON failures, retained WAV data, cached-text recovery, conversation
  changes, toast lifetime, localization, action styling and replacement confirmation in unit tests.
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
- The runtime logging format is unchanged by the retry feature. Each uploaded attempt is a
  separate request; a cached-text insertion does not generate another service request or log.
