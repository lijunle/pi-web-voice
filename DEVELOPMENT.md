# Development guide

This document is for understanding, modifying, and validating pi-web-voice. For setup,
configuration, and operational troubleshooting, use [USAGE.md](USAGE.md). Version changes
belong in [CHANGELOG.md](CHANGELOG.md).

## Runtime architecture

The server/CLI code uses CommonJS. Unit and server integration tests use Node's native
test runner and ES modules; browser integration and live E2E use Playwright Chromium.
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
| Audio-context policy / close and resume waits | Fresh per take; up to 3 seconds for each wait |
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
2. Each take gets a fresh `MediaStream` and `AudioContext`. After acquisition, opening
   waits for any preceding context-close promise to settle before creating the context,
   with a three-second bound. A fresh suspended/interrupted context gets its own bounded
   resume. Timeout or failed activation releases the microphone.
3. Capture resets the sample buffer and records via `ScriptProcessor`, downsampling to
   16 kHz through a silent gain path. The clock starts at graph readiness. Audio callbacks
   enforce the ten-minute wall-clock limit; clock rendering only displays elapsed time.
4. Stop releases tracks, clears the processor callback, disconnects all retained graph
   nodes, requests context closure, and merges chunks into a WAV. Zero samples produce
   a client error using the pre-cleanup context state. Success, cancellation, and failure
   all discard the context. Per-resource teardown guards keep cleanup best effort;
   rejected closes settle safely, while pending closes remain tracked for the next
   opening. A late callback from an old processor cannot append to a new take.
5. Stop snapshots the page's session ID and working directory alongside the WAV and
   timing in the pending take. Keep the same conversation open throughout recording,
   since a mid-recording switch can change this Stop-time destination. Retry uploads
   when text is unavailable and uses local insertion when the take holds cached text.

Consecutive takes in the same conversation use distinct audio contexts. Sample buffers
reset per take, and pending data stays tied to its Stop-time conversation. Each page
owns its opening guard. Retry reuses the WAV and its `audio_context=per-take` policy
marker while keeping audio resources closed. The server logs unrecognized or missing
markers as `unspecified`, including requests from older open pages. This metadata is a
client declaration rather than proof of healthy capture. See
[Recording and retry](USAGE.md#recording-and-retry) for replacement confirmation and
page-memory retention behavior.

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

Node.js 20+ runs the application and unit suite directly from a checkout. Use
**Node.js 22.19+** for the full development check, matching pi-web's requirement.
Install the locked development tools, Playwright Chromium, and the pi-web host:

```bash
npm ci
npx playwright install chromium
npm install -g @agegr/pi-web@0.9.0  # compatibility baseline; supply pi-web on PATH
npm run check
```

On Linux CI, use `npx playwright install --with-deps chromium` to install browser
system libraries too. Playwright 1.63.0 supplies a versioned Chromium; the tests use
its Playwright driver for navigation, input, requests, and resource cleanup. Use this
managed browser for reproducible checks across developer machines and CI.

TypeScript 6, Node 20 type definitions, and Playwright are development dependencies.
The application executes its CommonJS source directly with zero runtime dependencies;
Playwright and the test fixtures stay outside the published runtime files.

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
npm run check             # server type checking + all unit and integration checks
npm run typecheck         # static checking only
npm test                 # all unit and integration checks, including browsers
npm run test:unit
npm run test:integration  # server fixtures + browser fixtures + real pi-web/mock
npm run test:e2e          # opt-in real speech call; provider usage may be billed
```

`test/run.mjs` clears inherited `NODE_OPTIONS` so child suites exercise the checkout's
own hook. Default checks explicitly select mock and run each stage sequentially with
bounded suite timeouts. A failing stage exits nonzero; automatic retries are outside
the runner's behavior. Keep real speech calls in the explicitly selected E2E tier.
Use the npm commands so the outer supervisor owns each suite's private directory and
process cleanup, including forced timeouts and interruption. The runner supplies the
live opt-in marker only for `test:e2e`; direct/native test discovery of that entry point
fails before reading provider configuration or starting a browser/server.

| Tier | Files | Boundary and requirements |
| --- | --- | --- |
| Unit | `test/unit/*.test.mjs` | Native Node tests, DOM/VM harness, mocked provider fetch; Node 20+ |
| Integration | `test/integration/*.test.mjs` | Local HTTP servers, CLI subprocesses, temporary configuration/session files |
| Integration | `test/integration/harness-browser.mjs` | Playwright Chromium + loopback services; driver timeouts, request budgets, and cancellation |
| Integration | `test/integration/browser.mjs` | Playwright Chromium + local response fixture; synthetic Web Audio |
| Integration | `test/integration/pi-web.mjs` | Playwright Chromium + real pi-web + checkout hook + mock speech provider |
| E2E | `test/e2e/speech.mjs` | Playwright Chromium + real pi-web + real configured speech provider + composer insertion |

All browser integration scripts belong to the same `test:integration` command.
The pi-web integration and E2E helpers own a loopback server on a temporary port, a
private temporary HOME, and an isolated browser context. They select a project through
pi-web's real UI before waiting for the microphone button. Service workers stay blocked;
a guard installed before application code keeps microphone acquisition synthetic.

The supervisor owns the suite's private directory outside the child process. Linux/macOS
suite process groups include the host descendants, so forced termination also releases
host sockets and removes credential files when child cleanup cannot run. Windows uses
a bounded `taskkill /t /f` path; its process-tree behavior requires Windows validation.
Normal host exit/failure aborts the browser callback, and fixture servers close even if
browser cleanup fails. Polling bounds the awaited condition itself, and response-body
reading has a separate bound after HTTP headers arrive.

### Live E2E and credentials

Configure a real backend as described in [USAGE](USAGE.md#backends), then explicitly
run `npm run test:e2e`. It reads the selected configuration from the normal environment
or `~/.pi/agent/voice.env`; mock configuration produces a failure before browser/server
startup. The host helper validates settings before creating files and copies only
supported voice settings into its temporary `0600` configuration file. It adds one
outer quote pair to preserve literal values through the project's parser. Browser
processes receive a credential-free environment, and the host uses a fresh agent
directory with no personal sessions or extensions.

E2E plays the committed [synthetic speech fixture](https://github.com/lijunle/pi-web-voice/blob/main/test/fixtures/README.md) after the
capture graph is ready. The network guard permits one transcription POST only after
the complete take is ready; it blocks early or duplicate uploads before server dispatch
and records unexpected application writes, including external writes. E2E requires a
valid, non-silent PCM WAV, recognizable nonempty text, and exact draft insertion.
Response-read/JSON failures use bounded, redacted diagnoses in the test output.
Provider compatibility fallbacks can make an additional upstream attempt within that
one POST. This checks a small English sample, not general recognition accuracy or
physical microphone behavior.

Agent model credentials are separate from speech credentials. These tests finish at
the composer and block chat submission/agent-start requests, so they require no agent
key or model turn. Use mock integration for ordinary CI. For real E2E on GitHub Actions,
use a manually triggered job with environment approval, a dedicated speech-service key
in an Environment Secret, and endpoint/deployment settings in environment variables.
Keep real speech credentials outside pull-request jobs.

### GitHub Actions

The repository has three workflows with separate credentials and triggers:

| Workflow | Trigger | Checks / action | Credentials |
| --- | --- | --- | --- |
| [CI](https://github.com/lijunle/pi-web-voice/actions/workflows/ci.yml) | Push to `main`, pull request, manual run, or reusable call | Node 20.0.0/22/24/26 type/unit/server checks; Node 24 browser integration; package inspection | Read-only repository token; mock speech |
| [E2E](https://github.com/lijunle/pi-web-voice/actions/workflows/e2e.yml) | Manual run on `main` with `confirm_live` selected | One real speech/browser round trip | `speech-live` Environment |
| [Publish](https://github.com/lijunle/pi-web-voice/actions/workflows/publish.yml) | A published, stable GitHub Release | Validate tag/version, run reusable CI, publish npm with provenance | `npm` Environment and OIDC |

CI uses Ubuntu 24.04. It installs `@agegr/pi-web@0.9.0` explicitly for browser checks;
that package supplies its own pi coding agent dependency. Playwright installs its locked
Chromium and Linux libraries with `--with-deps`. Node-only jobs use the locked
development tools and local fixtures. Keep the runtime dependency list empty; the external host
installation belongs to test setup. The host's top-level version is pinned, while its
transitive ranges resolve during installation.

Actions use full commit pins for `actions/checkout` v7.0.1 and `actions/setup-node`
v7.0.0, and checkout leaves Git credentials out of the working tree. Superseded CI
runs cancel; live and publish runs serialize separately. CI uses
local fixtures and mock responses, independently of live-provider or publishing setup.
Use the Actions logs to inspect each job's actual commands and test results.

#### GitHub-hosted validation

[CI run 34249110453](https://github.com/lijunle/pi-web-voice/actions/runs/34249110453)
validates commit `a5c352f` on Ubuntu 24.04. All five jobs pass: Node 20.0.0/22/24/26
checks and browser integration. The browser job uses Node 24.20.0 and npm 11.19.0,
installs pi-web 0.9.0 and managed Chromium, passes 48 server checks plus 8 + 63 + 25
browser checks, and inspects the runtime package. This provides Linux process-tree and
browser validation alongside the local macOS record.

E2E and Publish have workflow definitions but no execution in this record. Their
external environment/publisher setup remains a prerequisite for those operations;
CI passes independently with no speech keys or npm publication.

#### Configure live E2E

Create the `speech-live` Environment in GitHub repository settings. Restrict deployments
to `main` and configure required reviewers before storing credentials. Add values through
GitHub settings; keep key values out of chat, commits, and workflow inputs.

For the default Azure OpenAI backend:

| Environment setting | Kind | Value |
| --- | --- | --- |
| `AZURE_OPENAI_API_KEY` | Secret | A dedicated test resource key |
| `AZURE_OPENAI_ENDPOINT` | Variable | The complete transcription endpoint |
| `PI_VOICE_DEPLOYMENT` | Variable, optional | Deployment name; default `gpt-transcribe` |
| `PI_VOICE_PROVIDER` | Variable, optional | Default `azure-openai` |

For Azure Speech, select `azure-speech` and supply the `AZURE_SPEECH_ENDPOINT` variable
and `AZURE_SPEECH_KEY` secret. For an OpenAI-compatible service, select `openai`, supply
`OPENAI_API_KEY` as a secret, and optionally set `PI_VOICE_OPENAI_BASE_URL` and
`PI_VOICE_OPENAI_MODEL`. See [backend settings](USAGE.md#backends). Supply only the selected
backend's key, and make its endpoint reachable from the GitHub-hosted runner.

Choose **Actions → E2E (live speech) → Run workflow**, select `main`, and check
`confirm_live`. Approve the environment deployment as configured. Secrets are scoped
to the final E2E step, after dependency/browser installation. The default Azure OpenAI
configuration fails before a speech call when its key or endpoint is missing.
A run without the confirmation or on another branch skips
the speech job; treat that as an unexecuted test, not live validation.

#### Configure npm publishing

Create an `npm` Environment with release approval and deployment rules for release tags
such as `v*`. Protect release-tag creation for maintainers. In the `pi-web-voice` package's
npm settings, add a [GitHub Actions trusted publisher](https://docs.npmjs.com/trusted-publishers/):

- Organization/user: `lijunle`
- Repository: `pi-web-voice`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: enable direct `npm publish`

The publish job uses GitHub-hosted Ubuntu, Node 24, npm 11.19.0, and `id-token: write`.
It obtains short-lived publishing credentials through OIDC; keep a long-lived npm token
out of GitHub Secrets. Dependency installation and publication use `--ignore-scripts`,
and the compiler has no build output to publish.

For a release:

1. Select an unused stable version. Update `package.json`, `package-lock.json`, and the
   dated changelog entry; use `npm version patch --no-git-tag-version` for a patch bump.
2. Run `npm run check`, review `npm pack --dry-run --ignore-scripts`, and commit the
   release preparation.
3. Tag the reviewed commit as `v<package.json version>` and push the commit and tag.
4. Publish a non-prerelease GitHub Release for that tag, then approve the `npm`
   environment deployment as configured.

The workflow verifies package/lockfile versions, repository identity, and that the
version is absent from npm, then runs the complete reusable CI before publishing the
release commit. Drafts, prereleases, ordinary pushes, and live E2E do not publish a
package. Use a new version for each npm publication; `0.1.7` already exists in the registry.
Live speech credentials and E2E success are separate from this publishing gate.

### Automated coverage

- **Test harness:** pending evaluations and body reads, late rejections, malformed-response
  redaction, one-upload enforcement before dispatch, and host-driven browser cancellation.
  POSIX child fixtures cover success, callback failure, early process exit, an unresponsive
  suite, cancellation, and missing pi-web installation; sockets close and private files clear.
- **Configuration and CLI:** direct CommonJS commands, private configuration initialization,
  file caching, environment precedence, literal quote round trips, rejected configuration
  without temporary files, and file-based credential isolation in child fixtures.
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
  streams and contexts per take, full graph teardown, stale-callback isolation, clean
  buffers, and activation-based timing. Closing waits serialize context creation and
  cover cancellation, rejection, timeout, and late completion.
- **Recovery and response contracts:** fresh running/suspended/interrupted contexts,
  disposal of leftover contexts, failed/stalled/timed-out resumes, zero-sample cleanup,
  capture-policy log validation, and client/server error distinctions. Real
  `Response`/`ReadableStream` tests cover HTML/plaintext/empty bodies, malformed/schema-invalid
  JSON, bad/missing content types, and response-read failures.

The browser integration fixture controls response timing and tests English desktop
and Chinese 320 px narrow-screen layouts. It checks persistent red errors, white underlined
Retry text with a transparent background and zero border, keyboard focus, a minimum
44 × 44 px touch target, long-message wrapping/scrolling, single-notice behavior, and
cleanup/refresh. It also checks distinct real audio contexts for consecutive takes,
closure after success/cancellation, capture-policy metadata through Retry, generated
Web Audio streams, mouse/keyboard interaction, HTML/plaintext/empty 502 responses,
invalid/empty HTTP 200 responses, and a TCP response
cut after 502 headers. Its response-reader guard enforces the single `text()` read path;
recovery uses the retained WAV and inserts the transcript exactly once.

The real-pi-web integration checks injection and mounting, terminal exclusion,
synthetic-audio capture, delayed microphone opening/cancellation, and abandoned pointer
gestures. Three consecutive takes in the same page each require a fresh context, an
actual PCM WAV upload, HTTP 200 with the mock provider, and exactly one insertion of
the returned text at the selected draft range. Original draft surroundings and terminal
text stay intact; pending audio, notices, tracks, and capture nodes clear on success.

The suite samples the clock after mouse-down, holds until it observes another tick,
and releases in a cleanup block, so a tick before the press cannot satisfy the assertion.
It advances the recorder clock across the ten-minute boundary and waits for actual audio
callbacks to verify automatic stopping. Readiness follows mounted UI, captured samples,
responses, and resource state with bounded waits. Deliberate hold delays exercise timing
contracts rather than substitute for readiness. Unit tests of the shared success contract
reject stale drafts, incorrect/duplicate insertion, notices, retained audio, wrong providers,
empty results, and terminal modifications. WAV checks validate PCM format, byte/block
rates, declared chunk sizes, complete samples, and non-silent fixture audio so the mock
provider's acceptance of arbitrary bytes cannot hide a broken capture/encoding path.

### Manual verification

The maintainer uses pi-web-voice on iPhone Safari and as an installed home-screen PWA.
Manual validation also covers the deployed underlined Retry presentation and live
backend VAD probes. The iOS 26.6.1 PWA report describes zero samples with a running
context and recovery after a background/foreground transition.

The **2026-09-08 validation record** covers the per-take-context implementation:

- **iPhone home-screen PWA, iOS 26.6.1:** the maintainer confirms normal voice input
  with the deployed implementation.
- **Deployment:** the served client matches the checkout. Two observed Azure OpenAI
  request logs report `audio_context=per-take` and `result=transcribed`; verification
  uses existing request metadata and makes no additional live speech-service calls.
- **Per-take regression coverage:** Node checks cover unit and local integration
  behavior; the browser fixture covers 63 synthetic-audio checks.

The **2026-09-08 test-tier validation** uses the working tree based on `9260b2b`, macOS arm64,
Node 26.8.1, pi-web 0.9.0, Playwright 1.63.0, and Chromium 153.0.8010.12:

- **Review regression:** `npm run check` passes static checking, 157 unit tests,
  48 server integration tests, 8 browser harness checks, 63 browser fixture checks,
  and 25 real-pi-web/mock integration checks. Review checks use isolated services
  only; the original eight Node test files retain every assertion.
- **Compatibility:** Node 20.0.0 passes static checking, all 157 unit tests, and the
  48 server integration tests. Browser/host checks use the Node 26 environment above.
  POSIX process-tree regression checks apply to macOS/Linux; Windows has no validation
  record here.
- **Live-provider evidence:** one synthetic-speech browser upload through Azure OpenAI
  `gpt-transcribe` uses a deployment-style URL with `api-version=2025-03-01-preview`,
  automatic VAD, zero conversation terms, and exact composer insertion. The request
  reports 5.2 seconds of captured audio, 1.7 seconds of route time, and 72 returned
  characters. This record verifies speech recognition and insertion; the request guard
  and supervisor have separate isolated regression coverage. The private resource
  endpoint and key stay in local configuration; the record makes no region-availability
  assertion.
- **Opt-in boundary:** native discovery of the live entry point fails before provider
  configuration, and selecting mock for `test:e2e` exits nonzero before service startup.
  Provider usage belongs only to the explicit live-provider record above.

Continue daily use to assess recurrence of the intermittent failure. The normal-input
check establishes current functionality, while isolated Chromium checks verify lifecycle
behavior rather than reproduce the reported iOS failure.

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

Use a fresh microphone stream and audio context for each take, and reset its sample
buffer. Measure opening time from accepted activation to graph readiness, including
fresh-context setup and any wait for preceding closure. Compare timings that share the
same measurement origin and reported capture policy.

Keep the icon, clock element, and clock text node mounted while updating their properties.
Stable hit-test targets let a mouse-down/up sequence complete across a clock tick,
keeping stop activation reliable.

### Safari recovery and response normalization

[iOS Safari can leave an audio context interrupted](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state#resuming_interrupted_play_states_in_ios_safari).
Each take creates its own context, activates it with a bounded resume when needed, and
requires `running` before graph setup. Stop closes the context on every path, including
healthy takes. This avoids keeping suspended contexts across takes at the cost of fresh
setup latency on each activation; real-device use evaluates the reliability trade-off.

A `running` state alone does not guarantee samples. WebKit reports
[#263627](https://bugs.webkit.org/show_bug.cgi?id=263627) and
[#291892](https://bugs.webkit.org/show_bug.cgi?id=291892) describe related audio-lifecycle
failures, including running contexts with stalled audio and standalone PWA behavior.
Their playback symptoms are related evidence, not confirmation of the microphone
failure's root cause. Keep the capture mechanism, readiness clock, and upload flow
stable while evaluating the per-take-context policy.

Diagnose page reload, foreground recovery, and authentication separately. An iOS
home-screen web app has [separate cookies and storage from Safari](https://developer.apple.com/videos/play/wwdc2023/10120/).
Use the affected app's own script/request evidence when investigating caching or Access
sessions. Foreground transitions leave microphone acquisition tied to explicit activation.
Client-local capture errors have no backend request log or diagnostic upload endpoint.

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
