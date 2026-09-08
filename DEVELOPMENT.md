# Development guide

This document is for understanding, modifying, and validating pi-web-voice. For setup,
configuration, and operational troubleshooting, use [USAGE.md](USAGE.md). Version changes
belong in [CHANGELOG.md](CHANGELOG.md).

## Runtime architecture

The server/CLI code uses CommonJS; tests use Node's native test runner and ES modules.
The browser code is a single self-contained script. The runtime uses Node.js and browser
APIs directly, and the source files run as-is.

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
                  browser composer (user reviews and sends)
```

`patch.cjs` wraps `http.Server.prototype.emit`, catching both `createServer(handler)`
and `server.on("request")`. Voice routes run before application listeners; other
requests reach the application with HTML responses wrapped for injection. The hook
strips `accept-encoding` on that path and injects into identity-encoded UTF-8 HTML.
Compressed responses, explicit alternative charsets, JSON, SSE, and binary bodies pass
through directly. Object and raw-array response headers are supported; HTML injection
removes content length from a copy, preserving caller-owned headers.

A streaming decoder preserves UTF-8 boundaries before and after insertion, honoring
byte views and the encoding argument for string chunks. A buffer that exceeds
`1024 * 1024` JavaScript string code units while awaiting an insertion point triggers
an unmodified flush. Decoding continues after this search limit to preserve split
characters. The threshold check runs after each chunk; `end()` handles its content
separately. Keep this text-scan threshold distinct from a byte-based memory limit.
Native writer calls sit outside transformation recovery and propagate their errors once.

Installation is idempotent because the launcher can preload the hook in a parent and
child. Only a process that listens announces activation. Browser configuration contains
just the route prefix and provider; credential objects stay server-side.

| Route | Role |
| --- | --- |
| `/__voice/inject.js` | Reads the active installed client file on every request and prepends browser configuration |
| `/__voice/health` | Reports the configured provider locally |
| `/__voice/terms` | Returns vocabulary for a supplied session/project |
| `/__voice/transcribe` | Accepts a nonempty POST body, mines vocabulary, invokes a provider, and returns text plus metadata |

Provide access control before requests reach these voice handlers. See
[Privacy and access control](USAGE.md#privacy-and-access-control) for deployment and
information-flow boundaries.

### Runtime constants

User-configurable settings are listed in the [settings reference](USAGE.md#settings-reference).
The constants below describe implementation choices; inspect the active configuration
separately when diagnosing a running service.

#### Shared constants

| Constant / behavior | Current value |
| --- | --- |
| Route prefix | `/__voice` |
| Capture format and maximum duration | 16 kHz mono PCM WAV; approximately 10 minutes |
| Server upload ceiling / upstream fetch-to-headers timeout | 25 MiB / 10 minutes |
| Audio-context resume timeout | 3 seconds |
| Candidate cap / project history | 400 ranked terms / up to five recent sibling sessions |
| Session read limits | Current session tail: 256 KiB; each sibling: at most 128 KiB |
| Project header scan limit | First JSONL line, up to 64 KiB |
| Vocabulary cache / project index TTL | 20 seconds / 60 seconds |
| Keyboard shortcut | `Cmd/Ctrl+Shift+V` |

#### Backend-specific constants

Only the selected provider's values apply. The quick start uses `azure-openai` with
`gpt-transcribe`, a deployment choice controlled by `PI_VOICE_DEPLOYMENT`. The MAI model,
API version, and style belong exclusively to the optional `azure-speech` backend.

| Provider | Constant / behavior | Value |
| --- | --- | --- |
| `azure-openai` | API version when constructing a deployment URL | `2024-10-21`; a complete endpoint URL keeps its own `api-version` |
| `azure-openai` | Vocabulary budget | 60 terms |
| `azure-speech` | Model / API version / style | `MAI-Transcribe-2` / `2025-10-15` / `clean` |
| `azure-speech` | Vocabulary budget | 50 terms |
| `openai` | Vocabulary budget | 60 terms |
| `mock` | Vocabulary budget | 50 terms |

The complete GPT Transcribe URL in the quick start supplies
`api-version=2025-03-01-preview`. That URL controls the API version for its request.

`config.cjs` parses the credential file into a private object cached in the process,
keeping file-based credentials scoped to server-side consumers. Exported variables
retain their precedence and child-process inheritance. `PI_CODING_AGENT_DIR`, when
supplied by the host environment, controls session discovery; the credential file stays
at its home-relative `~/.pi/agent/voice.env` path.

### Microphone, context, and pending-take lifecycle

`ui` owns the idle/recording/working state, the opening guard, notices, and one pending
take. `recorder` owns the microphone stream, Web Audio nodes/context, and sample chunks.

1. One accepted activation makes one microphone-opening attempt. Acquisition starts
   through the click/keyboard controller. Cancellation holds the guard until the
   outstanding request settles and cleanup closes any late stream.
2. Each take gets a fresh `MediaStream`. A healthy `AudioContext` belongs to its page:
   recording resumes it and stopping suspends it. Separate tabs own separate contexts.
3. Capture resets the sample buffer and records via `ScriptProcessor`, downsampling to
   16 kHz through a silent gain path. The clock starts at graph readiness. Audio callbacks
   enforce the ten-minute wall-clock limit; clock rendering only displays elapsed time.
4. Stop releases tracks, disconnects the processor, and merges chunks into a WAV.
   Zero captured samples produce a client error and discard the context for a fresh
   attempt. Failed activation also releases resources and discards the context.
5. Stop snapshots the page's session ID and working directory alongside the WAV and
   timing in the pending take. Keep the same conversation open throughout recording,
   since a mid-recording switch can change this Stop-time destination. Retry uploads
   when text is unavailable and uses local insertion when the take holds cached text.

Conversations in the same tab share a healthy audio context. Sample buffers reset per
take, and pending data stays tied to its Stop-time conversation. Each page owns its
opening guard. See [Recording and retry](USAGE.md#recording-and-retry) for replacement
confirmation and page-memory retention behavior.

Composer lookup excludes xterm's hidden helper textarea and prefers the textarea near
the mounted toolbar. Insertion uses the native textarea setter plus an input event so
React observes the change. Text remains in the chat composer for the user to review
and send, keeping the workspace terminal untouched.

### Response handling and error boundaries

The browser's `readTranscriptResponse` reads each response once with `text()`, then
parses JSON explicitly. Body-read interruption, HTTP failure, malformed response, and
an explicit empty transcript are separate outcomes:

- Preserve known HTTP status and a validated UUID request ID for diagnosis.
- Accept valid JSON across Content-Type variations. Display structured error strings;
  limit direct non-JSON response notices to format, status, and validated request ID.
- Require a string `text` in successful responses. Retain audio for Retry on empty HTTP
  bodies, malformed JSON, and missing/non-string `text`. Treat explicit empty/whitespace
  strings as successful empty results and clear their pending takes.
- Use `VoiceError` for source-specific expected failures and client labels for unexpected
  local errors. Render notices through text nodes to keep error details inert.

The strict text-field contract applies at the browser-facing `/__voice/transcribe`
boundary. Provider adapters first require a JSON object. OpenAI-style adapters then
normalize its text with `String(text ?? "").trim()`: a missing field becomes empty and
a number becomes a string. Azure Speech requires an array of phrase objects when
`combinedPhrases` is present, treats an absent list as empty, and joins phrase text.
Keep these container guards and normalization rules distinct from the browser-facing
string-field contract.

Exception guards cache string message values and contain failures in metadata access
or string conversion. They use `Unknown error` when string conversion fails and preserve readable integer
status metadata separately.

The upload reader requires Buffer chunks and routes chunk-validation or assembly errors
through its promise. Keep request streams in binary mode so the original WAV bytes reach
the provider.

At the server, `routes.cjs` converts caught transcription failures to HTTP 502 and logs
upstream status separately from potentially private error bodies. Its JSON `error`
string can include the upstream body, which the browser renders as plain text. Review
structured error details as potentially private content. `doctor` also prints detailed
configuration and transcription diagnostics. Operational field definitions belong in
[Logs and diagnostic endpoints](USAGE.md#logs-and-diagnostic-endpoints).

### Provider requests and fallbacks

| Backend | Vocabulary / request shape | Compatibility fallback |
| --- | --- | --- |
| Azure OpenAI `gpt-transcribe` | `keywords[]`, `languages[]`, and scalar `chunking_strategy=auto` | On HTTP 400, retry with a prompt while retaining VAD |
| Other Azure OpenAI deployments | Bounded vocabulary prompt | Surface request failures to the caller |
| Azure Speech | `phraseList.phrases`, enhanced MAI mode, automatic language identification | On HTTP 400 with a nonempty list, retry once with an empty list |
| OpenAI-compatible | Model and bounded prompt at `/audio/transcriptions` | Use the service's default VAD behavior and surface request failures |
| Mock | Generate diagnostic text locally | Complete locally |

The Azure keyword branch matches `gpt-transcribe` in the endpoint or deployment name,
case-insensitively. Request shaping follows those configuration strings. Deployment-style
and v1 URLs are supported; v1 requests include a model field. Language hints for the
keyword branch use primary tags from `Accept-Language` in header order, deduplicate them,
append English, and retain the first three. English fits when that three-tag budget allows.

Parameter fallbacks operate inside the server request; manual Retry resubmits from the
browser. Use the provider response to diagnose the specific cause of an HTTP 400.
Whisper-style prompts cap joined vocabulary at 700 characters before adding the wrapper;
the budget measures text length in JavaScript string code units.

#### Request timeouts

Each upstream `fetch` attempt gets its own timer. `withTimeout` clears it when `fetch`
resolves with response headers. Response-body reading and the browser's upload/response
reader continue outside that timer under host-server and network limits. A compatibility
fallback starts a fresh timed attempt, so overall transcription duration can exceed
ten minutes. Keep fetch-to-headers timing distinct from end-to-end request duration.

## Development and testing

### Environment and active installation

Node.js 20+ runs the application and unit suite directly from a checkout. Install the
locked development tools before running the full check:

```bash
npm ci
npm run check
```

TypeScript 6 and Node 20 type definitions are development dependencies; the application
continues to execute its CommonJS source directly. Browser suites require **Node.js 22+**
for global WebSocket and Microsoft Edge by default; set `BROWSER=/path/to/chromium`
to use another Chromium binary.

Identify the active installation through the service's `NODE_OPTIONS` and
`pi-web-voice hook-path`. Update that copy to apply changes. Client changes need a page
reload; backend or credential-file changes need a service restart. Handle pending audio
before reloading. See [Upgrading and uninstalling](USAGE.md#upgrading-and-uninstalling).

### Static type checking

`npm run typecheck` runs TypeScript with `allowJs`, `checkJs`, `strict`, and `noEmit`.
Its scope is `hook.cjs`, `bin/**/*.js`, and `lib/**/*.cjs`. It uses NodeNext module
resolution and Node 20 types with the ES2022 library. Browser code and `.mjs` test
sources receive runtime test coverage; this configuration checks the server side.

Describe function inputs, returns, shared contracts, and nullable state with JSDoc.
Reuse inferred configuration types through `ReturnType<typeof loadConfig>` and let
local values infer their types. Keep external JSON and caught exceptions as `unknown`
until guards narrow them. Runtime checks validate data shapes; static checks validate
how the implementation uses those shapes.

HTTP wrappers use a small typed reflection bridge to preserve Node's overloads,
argument lists, receivers, and return values. Keep casts local to these known API
boundaries. The compiler operates as a source analyzer; Node executes the original
CommonJS files.

### Test commands and isolation

```bash
npm run check          # server type checking followed by the unit suite
npm run typecheck      # static checking only
npm test
npm run test:retry
npm run test:e2e -- http://127.0.0.1:31141
```

The unit and browser test commands use `test/run.mjs`, which clears `NODE_OPTIONS` in
the child suite so tests exercise the checkout's own code. `npm run check` combines
server type checking with `npm test`. Browser suites are opt-in; `npm test` selects only
`*.test.mjs` and remains independent of the TypeScript tools.

| Command | Environment | Speech-service access |
| --- | --- | --- |
| `npm run check` | TypeScript plus the unit-test environment below | Static analysis, local fixtures, and mock responses |
| `npm run typecheck` | Development dependencies and `tsconfig.json` | Static analysis only |
| `npm test` | Node tests, local HTTP servers, DOM/VM harness, mocked fetch | Local fixtures and mock responses |
| `npm run test:retry` | Own loopback fixture and isolated headless Chromium with generated audio | Local fixture only; synthetic audio supplies the input |
| `npm run test:e2e -- <url>` | A separately running pi-web plus headless Chromium | Uses the target's configured backend; select mock for isolated testing |

For a dedicated integration instance, run this separately before the E2E command:

```bash
PI_VOICE_PROVIDER=mock pi-web-voice -p 31141
```

The instance needs a working pi-web installation. Point tests at an isolated instance
with synthetic conversations. Browser profiles are temporary; the retry fixture uses
an ephemeral debug port, while the integration script uses port 9333.

### Automated coverage

- **Configuration and CLI:** direct CommonJS commands, private configuration initialization,
  file caching, environment precedence, and file-based credential isolation in child fixtures.
- **HTTP interception:** streamed/fixed HTML injection, split UTF-8, byte views, string
  encodings, immutable object/raw headers, content-length handling, compressed/alternative
  charset pass-through, callbacks, fluent return values, and single-call error propagation.
- **Provider contracts:** scalar VAD encoding, empty/nonempty results, requests with empty
  vocabulary, keyword fallback with VAD retained, provider registry membership, JSON
  container validation, and provider-specific request shapes.
- **Boundary guards and vocabulary:** unknown exceptions, hostile getters/proxies,
  integer status metadata, malformed session records, long/EOF-terminated headers,
  exact session IDs, string working directories, and prose-only extraction.
- **Routes and logs:** binary stream validation, distinct request IDs and outcomes for
  repeated uploads, timing/status fields, and a metadata-only log schema that keeps
  private request content separate.
- **Composer and retry:** identical WAV reuse, explicit sequential resubmission,
  conversation binding, cached-text recovery, replacement confirmation, and terminal isolation.
- **Audio ownership:** abandoned pointer holds, delayed/cancelled starts and resumes, late
  success/failure cleanup, at most one live stream per page in covered sequences, fresh
  streams with a reused page context, clean per-take buffers, and activation-based timing.
- **Recovery and response contracts:** simulated running/suspended/interrupted/closed
  contexts, failed/stalled/timed-out resumes, zero-sample reset, and client/server error
  distinctions. Real `Response`/`ReadableStream` tests cover HTML/plaintext/empty bodies,
  malformed/schema-invalid JSON, bad/missing content types, and response-read failures.

The isolated retry browser fixture controls response timing and tests English desktop
and Chinese 320 px mobile layouts. It checks persistent red errors, white underlined
Retry text with a transparent background and zero border, keyboard focus, a minimum
44 × 44 px touch target, long-message wrapping/scrolling, single-notice behavior, and
cleanup/refresh. It also exercises generated Web Audio streams, mouse/keyboard interaction,
HTML/plaintext/empty 502 responses, invalid/empty HTTP 200 responses, and a TCP response
cut after 502 headers. Its response-reader guard enforces the single `text()` read path;
recovery uses the retained WAV and inserts the transcript exactly once.

The real-pi-web suite checks injection and mounting, terminal exclusion, synthetic-audio
capture, delayed microphone opening/cancellation, and abandoned pointer gestures.
It holds a real mouse click across a clock tick and advances the recorder clock across
the ten-minute boundary to test the limit immediately. Its final round-trip smoke check
accepts either a nonempty composer or a recognized notice, including an error; the
isolated retry suite makes exact transcript-insertion assertions.

### Manual verification

The maintainer uses and validates pi-web-voice in long-term, everyday use on iPhone
Safari. Manual validation also covers the deployed underlined Retry presentation and
live backend VAD probes.

For audio/UI changes, regression scenarios include tab switching, background/foreground
transitions, permission cancellation, consecutive takes, resource release, and Retry.
Automated audio-state simulation and Chromium checks complement this real-device use.
Assess stream ownership from the application's tracks; the iOS recording indicator shows
system-level microphone activity.

For each requested manual/provider probe, record the commit, date, browser/device,
region, endpoint/API version, model/deployment, inputs, and result. Use synthetic audio,
conversation fixtures, and placeholder credentials in repository test data.

### Documentation and release checks

- Keep README focused on the entry point, USAGE on user behavior/configuration, and
  DEVELOPMENT on architecture, tests, and design evidence. Link between these guides.
- Describe current behavior and validation results in present tense with positive,
  actionable wording. Keep change narratives and release state in CHANGELOG, the sole
  exception to these two writing rules.
- Use Keep a Changelog categories and dated version sections for release records.
- Check local links/anchors and the README's GitHub links, which also work from npm's
  package page. Keep the four user/developer Markdown files in `package.json`'s publication
  allowlist; AGENTS.md serves as repository guidance.
- Inspect publication contents with `npm pack --dry-run --ignore-scripts`. Keep runtime
  behavior and the package version stable during documentation-only maintenance.

## Design decisions and validation

These sections explain current implementation choices and the project's transcription
test results. Each result applies to its stated input and backend configuration. Keep
release and migration history in [CHANGELOG.md](CHANGELOG.md).

### Hook-based integration

The integration targets pi-web's prebuilt Next.js npm distribution. A `--require` hook
attaches at the Node HTTP layer and keeps the installed pi-web files intact across
package updates. This keeps maintenance focused on a small external integration.
Check toolbar selectors and session discovery when pi-web changes, since those browser
integration points depend on the host application's UI and request conventions.

### Click-only capture

Use one explicit activation for one microphone-opening attempt, and hold the opening
guard until completion or cancellation cleanup. This keeps acquisition tied to user
intent and makes ownership predictable across keyboard, touch, and accessibility input.
Idle pointer gestures leave the microphone closed.

Reuse a healthy page audio context to limit audio-session startup cost, while acquiring
a fresh microphone stream and resetting sample buffers for each take. Measure opening
time from accepted activation to graph readiness, and compare timings with that same
measurement origin.

Keep the icon, clock element, and clock text node mounted while updating their properties.
Stable hit-test targets let a mouse-down/up sequence complete across a clock tick,
keeping stop activation reliable.

### Safari recovery and response normalization

[iOS Safari can leave an audio context interrupted](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state#resuming_interrupted_play_states_in_ios_safari).
Resume interrupted/suspended contexts and require `running` before capture. Replace
closed contexts and bound resume to three seconds. Failed activation or zero samples
release resources and discard the context, giving another take a fresh start. Diagnose
cache behavior separately with script/request evidence, since page reload also resets
the audio lifecycle.

Read response text once, then parse JSON, so diagnostics preserve HTTP status and
identify the response format. Display direct non-JSON failures as bounded format
explanations and keep their audio available for Retry. Resolve upstream/proxy outages
using request evidence and the relevant service's operational diagnostics.

### VAD and silence handling

The project's live-probe dataset uses an Azure OpenAI `gpt-transcribe` deployment endpoint
with `api-version=2025-03-01-preview` and conversation vocabulary enabled. In these
samples, ungated synthetic silence produces vocabulary-influenced text. Scalar
`chunking_strategy=auto` requests service-side VAD; the table lists responses under
that configuration:

| Input | Result in the automatic-VAD dataset |
| --- | --- |
| 0.2-second and three-second synthetic silence | Empty text; ungated controls generate unrelated English |
| Quiet synthetic noise and a click | Empty text |
| Synthesized English and Chinese speech | Speech transcription, with ordinary recognition errors possible |
| Short words `Yes` and `好` | Successful recognition |
| Three seconds of silence followed by Chinese speech | Transcription of the subsequent speech |

Validation also includes a browser-path sample with three-second silence and 60 terms,
and manual use. Run live probes separately from `npm test` when requested, using input
that represents the intended microphone, background conditions, and quiet speech.

The endpoint probes return 400 for invalid scalar VAD values and ignore bracketed
fields such as `chunking_strategy[type]`. Use the scalar form and retain it during
keyword-to-prompt fallback. Other provider/model branches keep their
own VAD defaults. Audio reaches the service and remains subject to provider billing;
use provider evidence to determine the cause of an empty result.

### Vocabulary extraction and limits

The browser observes pi-web's session event/request URLs and obtains the working
directory from session creation or the UI. `context.cjs` matches the complete session ID
in `<timestamp>_<id>.jsonl`. Its project index reads `cwd` from the first JSONL line with
a bounded 64 KiB scan, independently of later messages or an incomplete tail. Vocabulary
scoring reads only user/assistant prose and extracts distinctive shapes such as camelCase,
kebab-case, filenames, paths, acronyms, and short backtick terms.

Within the text window, rank candidates by **weighted occurrence frequency**: user prose
gets 1.5 times assistant weight, and the current session gets three times the weight of
sibling sessions. Recency selects which sibling sessions and bounded file tails supply
text; term scoring then follows occurrences and source weights. Repeated project terms
keep weight even while discussion moves to a side topic.

Candidates are single words of 3–40 characters with a distinctive shape. Extraction
skips thinking/tool content and applies heuristic credential-pattern filtering. Review
the resulting terms for sensitive content beyond those patterns; see the
[privacy boundary](USAGE.md#privacy-and-access-control).

The West US Speech endpoint probe dataset contains these limits:

| Model | Phrase-list limit in the dataset | `transcribeStyle` support |
| --- | --- | --- |
| `MAI-Transcribe-2` | 50 | Supported |
| `MAI-Transcribe-1.5` | 200 | Unsupported |
| `MAI-Transcribe-1` | Unsupported | Unsupported |

These limits count words: a multiword phrase consumes multiple slots. The adapter
therefore uses 50 single-word terms for MAI-Transcribe-2. Apply this model-specific
budget to its requests and consult the provider's guidance for other models and endpoints.

The MAI comparison clip illustrates the quality/size trade-off: MAI-Transcribe-1.5 with
200 terms emits `hook c js` and `phrase list`, with lower accuracy and about twice the
latency of its vocabulary-free baseline. Choose a vocabulary budget for recognition
quality as well as capacity. Whisper-style prompts use a bounded free-form budget,
with Whisper's 224-token prompt window as a design reference; implementation limits
measure characters.

### Backend comparison and its limits

The comparison dataset consists of three synthesized Chinese-English sentences with
technical identifiers and the same mined vocabulary. The table summarizes its outputs,
latency measurements, and price assumptions:

| Measure | MAI-Transcribe-2 | gpt-transcribe |
| --- | --- | --- |
| Exact technical strings | Good | Better in these samples; retains `MAI-Transcribe-2` intact |
| Punctuation | Unpunctuated output | Punctuated output |
| Content omissions in the samples | Zero | One clause |
| Latency | About 1.0 s | About 2.6 s |
| Price basis per audio hour | $0.36 | $0.27 |

In the vocabulary-free controls, `hook.cjs` becomes `hookcjs` or `Hugging CJS`; with
vocabulary, both backends produce `hook.cjs`. Review transcripts for omissions as well
as spelling: a missing clause can be harder to notice than a misspelled term. Evaluate
realistic dictation alongside synthetic speech when selecting a backend.

Use current provider pricing, regional availability, and model lifecycle information
for deployment decisions. Treat the table's prices as comparison inputs, and check the
retirement schedule for the exact model version you select.
