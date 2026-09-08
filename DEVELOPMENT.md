# Development guide

This document is for understanding, modifying, and validating pi-web-voice. For setup,
configuration, and operational troubleshooting, use [USAGE.md](USAGE.md). Version changes
belong in [CHANGELOG.md](CHANGELOG.md).

## Runtime architecture

The server/CLI code uses CommonJS; tests use Node's native test runner and ES modules.
The browser code is a single self-contained script. There are no third-party runtime
dependencies, transpilation steps, or bundled frontend artifacts.

For a first pass through the implementation, start with these key files:

- [hook.cjs](hook.cjs) — loads configuration and connects the HTTP hook to the voice routes.
- [lib/routes.cjs](lib/routes.cjs) — handles voice requests and transcription metadata logging.
- [lib/providers.cjs](lib/providers.cjs) — builds speech-service requests and compatibility fallbacks.
- [public/inject.js](public/inject.js) — implements microphone controls, capture, retry, and composer insertion.

### Request and data flow

```text
bin/pi-web-voice.js
    │ starts pi-web with NODE_OPTIONS=--require <hook.cjs>
    ▼
hook.cjs → config.cjs + patch.cjs + routes.cjs
    │
    ├── HTML response → injected /__voice/inject.js
    │                         │ microphone → 16 kHz mono PCM WAV
    │                         ▼
    └── POST /__voice/transcribe
              ├── context.cjs → ranked session/project vocabulary
              └── providers.cjs → selected transcription backend
                                      │
                     JSON text ◀──────┘
                         │
                  browser composer (not auto-sent)
```

`patch.cjs` wraps `http.Server.prototype.emit`, catching both `createServer(handler)`
and `server.on("request")`. Voice routes are handled before application listeners;
other requests reach the application with HTML responses wrapped for injection.
`accept-encoding` is removed on that path to request an injectable identity response.
Non-HTML response bodies, including JSON, SSE, and binary assets, pass through without
HTML buffering. During streamed writes, if no insertion point is found and buffered text
exceeds `1024 * 1024` JavaScript string code units, it is flushed without injection.
This is a scan threshold, not a strict 1 MiB memory cap: it is checked after each chunk,
and content passed to `end()` is handled separately. There is no pi-web file modification
to reapply after an update.

The hook is installed idempotently because the launcher can preload it in a parent and
child. Only a process that listens announces activation. Its browser configuration
contains the prefix and provider, not the credential objects.

| Route | Role |
| --- | --- |
| `/__voice/inject.js` | Reads the active installed client file on every request and prepends browser configuration |
| `/__voice/health` | Reports the configured provider; does not contact it |
| `/__voice/terms` | Returns vocabulary for a supplied session/project |
| `/__voice/transcribe` | Accepts a nonempty POST body, mines vocabulary, invokes a provider, and returns text plus metadata |

These routes do not add their own authentication. Deployment implications and what
information may leave the process are documented in
[Privacy and access control](USAGE.md#privacy-and-access-control).

### Runtime constants

User-configurable settings are listed in the [settings reference](USAGE.md#settings-reference).
The constants below describe the implementation, not a snapshot of the active configuration.

#### Shared constants

| Constant / behavior | Current value |
| --- | --- |
| Route prefix | `/__voice` |
| Capture format and maximum duration | 16 kHz mono PCM WAV; approximately 10 minutes |
| Server upload ceiling / upstream fetch-to-headers timeout | 25 MiB / 10 minutes |
| Audio-context resume timeout | 3 seconds |
| Candidate cap / project history | 400 ranked terms / up to five recent sibling sessions |
| Session read limits | Current session tail: 256 KiB; each sibling: at most 128 KiB |
| Vocabulary cache / project index TTL | 20 seconds / 60 seconds |
| Keyboard shortcut | `Cmd/Ctrl+Shift+V` |

#### Backend-specific constants

Only the selected provider's values apply. The quick start uses `azure-openai` with
`gpt-transcribe`; its deployment name is configurable via `PI_VOICE_DEPLOYMENT`, not a
shared constant. The MAI model, API version, and style below belong exclusively to the
optional `azure-speech` backend and are not used by Azure OpenAI requests.

| Provider | Constant / behavior | Value |
| --- | --- | --- |
| `azure-openai` | API version when constructing a deployment URL | `2024-10-21`; a complete endpoint URL keeps its own `api-version` instead |
| `azure-openai` | Vocabulary budget | 60 terms |
| `azure-speech` | Model / API version / style | `MAI-Transcribe-2` / `2025-10-15` / `clean` |
| `azure-speech` | Vocabulary budget | 50 terms |
| `openai` | Vocabulary budget | 60 terms |
| `mock` | Vocabulary budget | 50 terms |

For example, the complete GPT Transcribe URL in the quick start uses
`api-version=2025-03-01-preview` as supplied; it does not use the constructed-URL default
or the Azure Speech API version.

`config.cjs` parses the credential file into a private object cached in the process.
It deliberately avoids `process.loadEnvFile`, which would export those credentials to
agent shell commands spawned as children. Already-exported variables still take priority
and remain inheritable. `PI_CODING_AGENT_DIR`, when supplied by the host environment,
affects session discovery, not the fixed home-relative `voice.env` path.

### Microphone, context, and pending-take lifecycle

`ui` owns the idle/recording/working state, the opening guard, notices, and one pending
take. `recorder` owns the microphone stream, Web Audio nodes/context, and sample chunks.

1. One accepted activation calls `getUserMedia` once. Pointer-down is not an audio
   trigger. Cancelling during opening keeps the guard until the outstanding request
   settles; any late stream is stopped before a new opening can proceed.
2. Each take gets a fresh `MediaStream`. A healthy `AudioContext` is reused within the
   page, resumed for capture, and suspended between takes. It is not shared across tabs.
3. Capture resets the sample buffer and records via `ScriptProcessor`, downsampling to
   16 kHz through a silent gain path. The clock starts at graph readiness, not at
   pointer-down or the first verified sample callback. The ten-minute wall-clock limit
   is checked in audio callbacks; the UI clock does not independently enforce it.
4. Stop releases tracks, disconnects the processor, and merges chunks into a WAV.
   No captured samples produces a client error and discards the context for a fresh
   attempt. Failed activation also releases resources and discards the context.
5. At Stop, a pending take stores its WAV and timing alongside the page's then-reported
   session ID and working directory in its request URL. Context is not snapshotted at
   recording start, so changing conversations mid-recording can change its destination.
   Once text arrives it can be cached on the take. Retry uploads only if text is not yet
   available; otherwise it attempts local insertion in the saved conversation.

Changing conversations in one tab does not require a new healthy audio context. Sample
buffers reset per take, and pending data remains conversation-bound. The opening guard
is per page, not a cross-tab microphone lock. Current user-visible behavior, including
replacement confirmation and page-discard loss, is in [Recording and retry](USAGE.md#recording-and-retry).

Composer lookup excludes xterm's hidden helper textarea and prefers the textarea near
the mounted toolbar. Insertion uses the native textarea setter plus an input event so
React observes the change. It never submits the text or sends it to the terminal.

### Response handling and error boundaries

The browser's `readTranscriptResponse` reads each response once with `text()`, then
parses JSON explicitly. Body-read interruption, HTTP failure, malformed response, and
an explicit empty transcript are separate outcomes:

- Known HTTP status and a validated UUID request ID are retained for diagnosis.
- Valid JSON is accepted despite a missing/incorrect Content-Type. Structured service
  error strings remain visible; raw non-JSON bodies and arbitrary headers do not.
- A successful response must contain a string `text`. An empty HTTP body, malformed JSON,
  or missing/non-string `text` is retryable; an explicit empty/whitespace string is a
  successful empty result that clears the pending take.
- `VoiceError` carries source-specific expected failures. Unexpected local errors are
  not relabeled as speech-service failures. Notices render text, not executable HTML.

This validation applies to the browser-facing `/__voice/transcribe` response, not the
raw provider response. The OpenAI-style adapters currently normalize upstream text with
`String(text ?? "").trim()`: a missing field becomes empty and a number becomes a string.
Azure Speech joins `combinedPhrases`, treating an absent list as empty. These adapters
do not enforce the browser's strict text-field contract on upstream JSON.

At the server, `routes.cjs` converts caught transcription failures to HTTP 502 and logs
upstream status separately from potentially private error bodies. Its JSON `error`
string can include the upstream body, which the browser renders as plain text; the
direct non-JSON response filter is not redaction of structured error details.
`doctor` is deliberately more verbose; it is not a metadata-only request logger.
The field definitions and operational caveats are maintained in
[Logs and diagnostic endpoints](USAGE.md#logs-and-diagnostic-endpoints).

### Provider requests and fallbacks

| Backend | Vocabulary / request shape | Compatibility fallback |
| --- | --- | --- |
| Azure Speech | `phraseList.phrases`, enhanced MAI mode, no fixed locales | On HTTP 400 with a nonempty list, try once without the list |
| Azure OpenAI `gpt-transcribe` | `keywords[]`, `languages[]`, and scalar `chunking_strategy=auto` | On HTTP 400, retry with a prompt while retaining VAD |
| Other Azure OpenAI deployments | Bounded vocabulary prompt | No structured-keyword fallback |
| OpenAI-compatible | Model and bounded prompt at `/audio/transcriptions` | No Azure-specific VAD override |
| Mock | Generated diagnostic text | No upstream request |

The Azure keyword branch is selected when the endpoint or deployment contains
`gpt-transcribe` (case-insensitive); it does not query Azure for the deployed model.
Deployment-style and v1 URLs are supported; v1 requests include a model field. For the
keyword branch, language hints are primary tags from `Accept-Language` in header order,
deduplicated with English appended and capped at three. English can fall outside the cap
when three other languages come first.

These server-side parameter fallbacks are not the browser's manual Retry feature, and
they do not establish the cause of every 400 response. Whisper-style prompts are kept
short: joined vocabulary is bounded to 700 characters before adding the prompt wrapper,
not measured in provider tokens.

#### Request timeouts

Each upstream `fetch` attempt gets its own timeout. `withTimeout` clears the timer when
`fetch` resolves with response headers; subsequent JSON/error-body reading is outside
that timer. The browser upload/response reader has no separate deadline set by this
package. A compatibility fallback starts a fresh timed attempt, so ten minutes is not
an end-to-end transcription deadline. Host-server and proxy limits are separate.

## Development and testing

### Environment and active installation

Node.js 20+ runs the application and unit suite. Browser suites require **Node.js 22+**
for global WebSocket and Microsoft Edge by default; set `BROWSER=/path/to/chromium` to
use another Chromium binary. No dependency installation or build is required to run the
unit suite from a checkout.

The active hook can be a different global installation. Check the service's
`NODE_OPTIONS` and `pi-web-voice hook-path` before concluding a checkout change is live.
Client changes need a page reload; backend or credential-file changes need a service
restart. Existing pending audio must be handled before reloading. See
[Upgrading and uninstalling](USAGE.md#upgrading-and-uninstalling).

### Test commands and isolation

```bash
npm test
npm run test:retry
npm run test:e2e -- http://127.0.0.1:31141
```

All three use `test/run.mjs`, which clears `NODE_OPTIONS` in the child suite. Otherwise
an installed hook could intercept the fixture or make tests exercise the wrong copy.
Browser suites are opt-in; `npm test` selects only `*.test.mjs`.

| Command | Environment | Speech-service access |
| --- | --- | --- |
| `npm test` | Node tests, local HTTP servers, DOM/VM harness, mocked fetch | No live speech requests; no browser/microphone needed |
| `npm run test:retry` | Own loopback fixture and isolated headless Chromium with generated audio | No pi-web, credentials, device microphone, or speech service required |
| `npm run test:e2e -- <url>` | A separately running pi-web plus headless Chromium | Uses the target's configured backend; choose mock to avoid charges |

For a dedicated integration instance, run this separately before the E2E command:

```bash
PI_VOICE_PROVIDER=mock pi-web-voice -p 31141
```

The instance still needs a working pi-web installation. Point tests at an isolated test
instance, not a production conversation. Browser profiles are temporary; the retry
fixture uses an ephemeral debug port, while the integration script uses port 9333.

### Automated coverage

- **HTTP interception:** streamed/fixed HTML injection, head/body fallbacks, content-length
  handling, and non-HTML JSON/binary/SSE behavior.
- **Provider contracts:** structured VAD encoding, empty/nonempty results, vocabulary-free
  requests, keyword fallback with VAD retained, and unchanged other-provider branches.
- **Routes and logs:** distinct request IDs and outcomes for repeated uploads, timing/status
  fields, and exclusion of transcripts, keys, private error bodies, and injected log text.
- **Composer and retry:** identical WAV reuse, no automatic or concurrent resubmission,
  conversation binding, cached-text recovery, replacement confirmation, and no terminal writes.
- **Audio ownership:** abandoned pointer holds, delayed/cancelled starts and resumes, late
  success/failure cleanup, at most one live stream per page in covered sequences, fresh
  streams with a reused page context, clean per-take buffers, and activation-based timing.
- **Recovery and response contracts:** simulated running/suspended/interrupted/closed
  contexts, failed/stalled/timed-out resumes, zero-sample reset, and client/server error
  distinctions. Real `Response`/`ReadableStream` tests cover HTML/plaintext/empty bodies,
  malformed/schema-invalid JSON, bad/missing content types, and response-read failures.

The isolated retry browser fixture controls response timing and tests English desktop
and Chinese 320 px mobile layouts. It checks persistent red errors, white underlined
Retry text without a separate border/background, keyboard focus, a minimum 44 × 44 px
touch target, long-message wrapping/scrolling, no stacked notices, and cleanup/refresh.
It also exercises generated Web Audio streams, mouse/keyboard interaction, HTML/plaintext/
empty 502 responses, invalid/empty HTTP 200 responses, and a TCP response cut after 502
headers. A guard fails if `Response.json()` is used; the same retained WAV must recover
and insert only once after the response failures.

The real-pi-web suite checks injection and mounting, terminal exclusion, synthetic-audio
capture, delayed microphone opening/cancellation, and abandoned pointer gestures.
It holds a real mouse click across a clock tick and advances the recorder clock across
the ten-minute boundary without waiting ten minutes. Its final round-trip smoke check
accepts either a nonempty composer or a recognized notice, including an error; the
isolated retry suite makes exact transcript-insertion assertions.

### Manual verification

The maintainer uses and validates pi-web-voice in long-term, everyday use on iPhone
Safari. Manual validation also includes the deployed underlined Retry presentation and
live backend VAD probes.

For future audio/UI changes, regression scenarios include tab switching,
background/foreground transitions, permission cancellation, consecutive takes, resource
release, and Retry. The automated suites simulate audio states and exercise Chromium;
they complement the maintainer's real-device use. An iOS recording indicator is not a
stream counter.

For each new manual/provider probe, record the tested commit, date, browser/device,
region, endpoint/API version, model/deployment, inputs, and observed result. Do not
store real credentials, private recordings, or conversation contents in test fixtures.

### Documentation and release checks

- README stays an entry point. User behavior/configuration belongs in USAGE; architecture,
  tests, and technical evidence belong here; release changes belong in CHANGELOG.
- Keep release status and version changes in CHANGELOG, using Keep a Changelog categories
  and dated version sections when publishing.
- Check local links/anchors and the README's GitHub links, which also work from npm's
  package page. Keep the four Markdown files in `package.json`'s publication allowlist.
- Use `npm pack --dry-run --ignore-scripts` to inspect package contents without publishing.
  Documentation-only changes do not require a release bump or a runtime-code refactor.

## Design decisions and validation

These sections collect the project's implementation decisions and transcription test
results, not additional configuration settings. Service measurements apply to the
resources, regions, and model versions tested.

### Why a hook instead of a fork

The pi-web npm distribution used for this integration is a prebuilt Next.js app without
source to patch cleanly. A `--require` hook attaches at the Node HTTP layer, leaves the
installed package unchanged, and needs no reapplication after a normal package update.
This is intentionally smaller than maintaining a fork or adding a build pipeline.
The toolbar selector and session-discovery integration still need compatibility checks
when pi-web changes; using Node's HTTP API does not make every frontend integration stable.

### Why click-only capture

Earlier code requested a microphone stream at finger-down, letting a later click claim
it to reduce perceived startup latency. That also requested access for abandoned touches
and required expiry/claim/fallback logic. The current design removes pre-warming: one
accepted activation, one request, with opening/cancellation serialized until cleanup.
It trades that speculative head start for simpler ownership and predictable activation.

A healthy audio context is still reused because recreating an audio session on every
take adds startup cost. Reusing that page-level context is different from retaining a
microphone stream or recorded samples. The timing field now starts at activation rather
than pointer-down; historical before/after numbers are not directly comparable.

The icon and clock nodes remain mounted while properties/text-node values change.
Replacing the mousedown target on a clock tick had caused Chromium to suppress the
subsequent click, making stopping appear to require another press.

### Safari recovery and response normalization

[iOS Safari can leave an audio context interrupted](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state#resuming_interrupted_play_states_in_ios_safari).
Recovery resumes interrupted as well as suspended contexts, requires `running`, replaces
closed contexts, and bounds resume to three seconds. Failed activation or zero captured
samples discards the context so another take can start fresh. This is lifecycle recovery,
not proof that a particular device failure was caused by stale JavaScript or caching.

Reading response text once before JSON parsing avoids replacing an HTTP error with
Safari's generic `Response.json()` exception. Format explanations preserve status and
retryable audio without rendering arbitrary error pages. Better error handling cannot
repair a real upstream/proxy outage or determine the cause of a 502 without request evidence.

### VAD and silence handling

Historical live probes used an Azure OpenAI `gpt-transcribe` deployment endpoint with
`api-version=2025-03-01-preview` and conversation vocabulary enabled. Ungated synthetic
silence could generate unrelated vocabulary-influenced text. Explicit scalar
`chunking_strategy=auto` fixed those reproduced cases without adding a browser VAD model
or a fixed duration/loudness cutoff.

| Input | Observed result with automatic VAD |
| --- | --- |
| 0.2-second and three-second synthetic silence | Empty text; ungated controls generated unrelated English |
| Quiet synthetic noise and a click | Empty text |
| Synthesized English and Chinese speech | Transcribed; ordinary recognition errors remained possible |
| Short words `Yes` and `好` | Recognized |
| Three seconds of silence followed by Chinese speech | Subsequent speech transcribed |

The deployed browser path was also checked with three-second silence and 60 terms,
followed by manual use. These live probes are not part of `npm test` and do not cover
every microphone, background voice, or quiet utterance.

On the tested endpoint, invalid scalar VAD values returned 400, whereas bracketed fields
such as `chunking_strategy[type]` were ignored. This is why requests use the scalar form,
and why a keyword-to-prompt retry must not silently remove VAD. Other provider/model
branches receive no new VAD parameter. Silence still reaches the service and can incur
usage; an empty result does not prove filtering or exempt billing.

### Vocabulary extraction and limits

The browser observes pi-web's session event/request URLs and obtains the working
directory from session creation or the UI. `context.cjs` resolves session JSONL files
under the agent directory and scores only user/assistant prose. It extracts distinctive
shapes such as camelCase, kebab-case, filenames, paths, acronyms, and short backtick terms.

Within the text read, ranking is by **weighted occurrence frequency, not message recency**:
user prose gets 1.5 times assistant weight, and the current session gets three times the
weight of sibling sessions. Recency selects which sibling sessions and bounded file tails
are read; it does not add a per-message recency multiplier. Earlier recency-based ranking
was reported to evict durable vocabulary after a few turns on a side topic.

Candidates are single words of 3–40 characters with a distinctive shape. Thinking/tool
content is skipped, and credential-like candidates are filtered heuristically. That is
not comprehensive secret redaction; see the [privacy boundary](USAGE.md#privacy-and-access-control).

Earlier West US Speech endpoint probes reported:

| Model | Observed phrase-list limit | `transcribeStyle` |
| --- | --- | --- |
| `MAI-Transcribe-2` | 50 | Supported |
| `MAI-Transcribe-1.5` | 200 | Rejected |
| `MAI-Transcribe-1` | Phrase lists unsupported | Rejected |

The recorded limit counted words, not entries, so multiword phrases consumed multiple
slots. This differs from general guidance mentioning up to 500 entries; the current
adapter uses a 50-term budget for MAI-Transcribe-2 based on these measurements.

MAI-Transcribe-1.5 with 200 terms was not selected simply for its larger list: on one
recording it produced `hook c js` and `phrase list`, worse than its own no-vocabulary
baseline and about twice as slow. Whisper-style prompts use a smaller free-form budget;
the original design used Whisper's 224-token prompt window as guidance, while the
implementation limits characters rather than measuring provider tokens.

### Backend comparison and its limits

Earlier comparisons used three synthesized Chinese-English sentences with technical
identifiers, the same mined vocabulary, and the list prices recorded at that time:

| Observation | MAI-Transcribe-2 | gpt-transcribe |
| --- | --- | --- |
| Exact technical strings | Good | Better in these samples; retained `MAI-Transcribe-2` intact |
| Punctuation | None | Added it |
| Dropped content | None observed | Dropped a clause once |
| Latency | About 1.0 s | About 2.6 s |
| Recorded list price per audio hour | $0.36 | $0.27 |

Vocabulary mattered in these samples: without it, `hook.cjs` became `hookcjs` or
`Hugging CJS`; with it, both backends produced `hook.cjs`. Silent omissions mattered
because a missing clause can be harder to notice than a misspelled term. Try realistic
recordings rather than assuming synthetic speech predicts dictation accuracy.

The table is not a current price quote or benchmark guarantee. Recheck pricing and
availability for the actual resource, date, and model version. Earlier notes also listed
15 October 2026 as the retirement date for `gpt-4o-transcribe` version `2025-03-20`;
verify the provider's current lifecycle information before choosing a deployment.
