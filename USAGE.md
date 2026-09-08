# Usage guide

For installation in a few steps, start with the [README](README.md). This guide covers
configuration, daily use, deployment, and troubleshooting. Implementation and test
details belong in [DEVELOPMENT.md](DEVELOPMENT.md).

## Installation and requirements

The runtime requires Node.js 20+, a working `pi-web` command, and a browser that supports
microphone capture and Web Audio. The integration's compatibility baseline is pi-web
`0.9.0` (pi `0.85.1`); check compatibility when selecting another version.
Browser-based developer tests have additional requirements, described in
[Development and testing](DEVELOPMENT.md#development-and-testing).

```bash
npm install -g @agegr/pi-web   # install the pi-web host as needed
npm install -g pi-web-voice
pi-web-voice init
```

Fill in one backend in the generated configuration file, then run:

```bash
pi-web-voice doctor
pi-web-voice
```

The package runs directly from source using Node.js and browser APIs. `npx pi-web-voice`
also works with an existing pi-web installation. Launcher arguments pass through to
pi-web, except its own commands and help options; for example, `pi-web-voice -p 8080`.

### Install from source

To run from a checkout:

```bash
git clone https://github.com/lijunle/pi-web-voice.git
cd pi-web-voice
npm install -g .
pi-web-voice init
```

Configure the backend and run `doctor` and `pi-web-voice` as above.

## Configuration

### Configuration file

Credentials and settings live in `~/.pi/agent/voice.env`, using the home directory of
the user running the service. `pi-web-voice init` creates the file with mode `0600` and
preserves an existing file.

The hook parses the file into a private object, separate from `process.env`. Write
literal `KEY=value` entries: the parser accepts optional `export`, matching outer
single/double quotes, blank lines, and full-line `#` comments. Supply values as literal
text and put comments on their own lines.

An existing environment value takes precedence over the file, including an empty
exported value. The process caches file values: **restart the service after changing
configuration**. On Unix, keep file permissions restricted:

```bash
chmod 600 ~/.pi/agent/voice.env
```

Store keys in this file so command lines and shell history stay free of credential
values. Exported service-environment values retain their precedence and remain available
to child processes; the private-file loader leaves existing exports intact.

### Settings reference

These nine settings cover provider selection, endpoints, credentials, and models.
Keep API keys secret and redact private resource details before sharing configuration.

| Variable | Default / purpose |
| --- | --- |
| `PI_VOICE_PROVIDER` | Explicit backend: `azure-speech`, `azure-openai`, `openai`, or `mock`; otherwise inferred |
| `AZURE_SPEECH_ENDPOINT` | Required for Azure Speech; resource name or resource URL |
| `AZURE_SPEECH_KEY` | Azure Speech resource key |
| `AZURE_OPENAI_ENDPOINT` | Required for Azure OpenAI; resource name, resource URL, or complete transcriptions URL |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI resource key |
| `PI_VOICE_DEPLOYMENT` | Azure OpenAI deployment; defaults to `gpt-transcribe` |
| `PI_VOICE_OPENAI_BASE_URL` | OpenAI-compatible API root; defaults to `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | OpenAI-compatible service key; may be empty for a local service |
| `PI_VOICE_OPENAI_MODEL` | OpenAI-compatible model; defaults to `whisper-1` |

When `PI_VOICE_PROVIDER` is empty, nonempty keys select Azure Speech first, then Azure
OpenAI, then OpenAI, with mock as the fallback. Set `PI_VOICE_PROVIDER` for explicit
selection, especially with a keyless local service. Endpoint settings supply the
destination for the selected backend.

The implementation defines route prefix, API-version defaults, recording/upload limits,
and vocabulary budgets as constants. See [Runtime constants](DEVELOPMENT.md#runtime-constants).

## Backends

The quick start uses Azure OpenAI with `gpt-transcribe`. Azure AI Speech (MAI) and
OpenAI-compatible services remain alternative backends.

### Azure OpenAI

```sh
PI_VOICE_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-03-01-preview
AZURE_OPENAI_API_KEY=your-resource-key
PI_VOICE_DEPLOYMENT=gpt-transcribe
```

Copy the complete transcriptions URL for your deployment from the Azure portal, using
the resource, model, and API version available to your account. The hook preserves a
complete URL, including its `api-version`. For a bare resource name or resource root,
it constructs a deployment URL using its built-in API-version default.

Deployment-style and `/openai/v1/audio/transcriptions` URLs are supported. A model field
is included for the v1 form. Set `PI_VOICE_DEPLOYMENT` to the actual deployment name even
when supplying a full URL: the hook chooses the structured branch when either the URL
or that setting contains `gpt-transcribe`. Request shaping follows those configured strings.

- `gpt-transcribe` uses structured vocabulary/language hints and requests automatic
  VAD with `chunking_strategy=auto`; a keyword-to-prompt fallback retains VAD.
- For `gpt-4o-transcribe` or whisper, update both endpoint and deployment setting to match
  that deployment. Their branch uses a bounded vocabulary prompt and leaves VAD behavior
  to the provider's defaults.

Recognition language remains automatic. The structured Azure OpenAI branch gets up to
three language hints from the browser's `Accept-Language`; English is appended as a
fallback if it fits within that limit. A valid empty transcription preserves the draft
and reports an empty result. Assess its cause from the audio and provider behavior.
Audio reaches the provider and can incur usage charges.

### Azure AI Speech

This optional backend is separate from Azure OpenAI. Use `azure-speech` for
MAI-Transcribe-2 fast transcription with automatic language identification, code
switching, and vocabulary supplied as `phraseList.phrases`.

```sh
PI_VOICE_PROVIDER=azure-speech
AZURE_SPEECH_ENDPOINT=https://my-resource.cognitiveservices.azure.com
AZURE_SPEECH_KEY=your-resource-key
```

A bare resource name expands to a `cognitiveservices.azure.com` URL. Supply the resource
root; the hook appends the transcription operation path.

**Region support matters.** The project's setup notes list `eastus`, `northeurope`,
`southeastasia`, `westus`, and `westus2` for MAI-Transcribe. Verify current availability
for the resource/model before provisioning, then use `doctor` to check it. Check
credential validity and regional model availability separately.

For example, with Azure CLI and an existing resource group:

```bash
az cognitiveservices account create --name my-speech --resource-group my-rg \
  --kind AIServices --sku S0 --location westus2 --yes
az cognitiveservices account show --name my-speech --resource-group my-rg \
  --query properties.endpoint -o tsv
az cognitiveservices account keys list --name my-speech --resource-group my-rg \
  --query key1 -o tsv
```

The last command prints a secret; store the key in `voice.env` and keep its output
private. The application caps this backend at **50 single-word vocabulary terms**.
See [Vocabulary limits](DEVELOPMENT.md#vocabulary-extraction-and-limits) for the rationale
and measurements.

### OpenAI-compatible services

For OpenAI:

```sh
PI_VOICE_PROVIDER=openai
OPENAI_API_KEY=your-api-key
```

For Groq, also set:

```sh
PI_VOICE_OPENAI_BASE_URL=https://api.groq.com/openai/v1
PI_VOICE_OPENAI_MODEL=whisper-large-v3
```

Use the chosen service's key in `OPENAI_API_KEY`. For a local whisper-compatible service,
set its API root and model and explicitly select `PI_VOICE_PROVIDER=openai`. Use an empty
key for a keyless local server. The service must accept the OpenAI-style multipart
`/audio/transcriptions` request; the hook appends that path to the base URL.

### Mock

```bash
PI_VOICE_PROVIDER=mock pi-web-voice
```

This inline environment syntax is for POSIX shells. In PowerShell, set
`$env:PI_VOICE_PROVIDER = 'mock'` before running `pi-web-voice`, or set the provider in
`voice.env` as in the README.

Mock generates diagnostic text locally from the received audio and, when available,
mined vocabulary. Use it to test the button, recorder, and HTTP round trip. Select a
speech backend for speech recognition. Browser microphone permissions still apply.

## Recording and retry

### Starting and stopping

Click the microphone next to image attachment, wait for `…` to become a clock, then
speak. Click again to stop. Each take opens a fresh microphone stream and a fresh
`AudioContext`. Treat the clock as a microphone/audio-graph readiness cue; use capture
diagnostics to assess sample collection.

An explicit click or equivalent activation opens the microphone. While idle, pointer-down,
held presses, and abandoned gestures keep it closed. Keyboard/VoiceOver activation,
`Cmd/Ctrl+Shift+V`, and supported headphone media controls use the same start/stop controller.

Clicking again during opening cancels the take. Browser permission requests continue
until they settle, so the button can remain disabled with **Cancelling microphone request**
while cleanup closes any late stream. Wait for cleanup before starting another take.
Each page serializes its own opening requests; separate tabs have separate controllers.

Stopping releases the microphone, disconnects the audio graph, and requests context
closure. Before creating another context, an opening waits up to three seconds for a
previous close to settle; activating the fresh context also has a three-second resume
bound. A timeout releases the new microphone and reports a client audio error. Each take
includes fresh-context setup in its opening time.

With audio callbacks running, a take stops automatically after approximately
**10 minutes**, then transcribes normally. Browser audio is 16 kHz
mono PCM WAV; a full-length take is about 19.2 MB, below the 25 MiB server upload ceiling.
Each upstream fetch has a 10-minute timeout until response headers arrive. Body reading
continues outside that timer, and a compatibility fallback starts another timed attempt,
so overall duration can exceed ten minutes. Proxies and the host server apply their own limits.

### Retry and conversation changes

On a retryable failure, the red error notice stays visible with an underlined **Retry**
action. Retry resubmits the same WAV while the microphone stays closed. The action is
disabled while transcribing; another failure updates the same notice, and success clears
the pending take. Each browser resubmission requires an explicit Retry action.
Backend parameter-compatibility fallbacks within a request are described in
[Development](DEVELOPMENT.md#provider-requests-and-fallbacks).

The page holds one pending take in memory:

- **Retry before reloading.** Refreshing, closing, or browser page discard clears the take.
- Starting a new take asks before replacement. Denied microphone access or a cancelled
  opening preserves the existing pending take.
- Stop captures the page's session and working directory for the pending take. Stay in
  the same conversation while recording, then return to the Stop-time conversation
  whenever you retry.
- When text is available but the composer is unavailable or the conversation changes,
  the page retains the text. Local recovery inserts this cached text and keeps the
  speech-service request count unchanged.
- An explicitly empty transcript is a successful server result. It clears the pending
  take, preserves the draft, and shows a server-empty-result notice.

Each uploaded retry may incur another provider charge. The provider can complete an
attempt even when the browser loses its response. Ordinary non-retryable notices expire
after four seconds; retryable notices remain until handled.

## Deployment and remote access

### HTTPS and access control

Microphone capture requires HTTPS or a browser-trusted loopback origin. `http://localhost`
and `http://127.0.0.1` work. For a LAN origin such as `http://192.168.1.10:30141`, configure
HTTPS with a certificate the device trusts.

| Situation | Approach |
| --- | --- |
| Remote machine, desktop client | Use `ssh -L 30141:127.0.0.1:30141 host`, then open `http://localhost:30141` |
| Phone/tablet or LAN access | Use HTTPS via an access-controlled proxy, [Tailscale Serve](https://tailscale.com/kb/1312/serve), or Caddy with a certificate trusted by the device |
| Desktop Chromium testing only | Limit `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.10:30141` to temporary desktop tests; use trusted HTTPS for deployment |

For iOS Safari, use a certificate the device trusts. HTTPS encrypts traffic; pair it
with a private origin or access control, including `/__voice/`. See
[Privacy and access control](#privacy-and-access-control).

### Running as a service

Keep pi-web's existing launchd or systemd launch command and add the hook to its
`NODE_OPTIONS`. Find the installed path with:

```bash
pi-web-voice hook-path
```

Use the resulting absolute path, preserving any existing Node options. On launchd, add
an entry to `EnvironmentVariables` in the service plist, for example:

```xml
<key>NODE_OPTIONS</key>
<string>--require /opt/homebrew/lib/node_modules/pi-web-voice/hook.cjs</string>
```

Reload the service definition (adjust the label/file for your installation):

```bash
launchctl bootout gui/$(id -u)/com.agegr.pi-web
# Check for an orphaned child still holding the port before bootstrapping:
lsof -nP -iTCP:30141 -sTCP:LISTEN
# If necessary, terminate only the identified orphan belonging to this service.
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agegr.pi-web.plist
```

Use `bootout` and `bootstrap` to load plist changes; `launchctl kickstart -k` uses
launchd's in-memory definition. A child `next start` process can retain the port.
Inspect the listener and terminate only the identified orphan for this service.

For a systemd user-service override:

```ini
[Service]
Environment="NODE_OPTIONS=--require /absolute/path/to/pi-web-voice/hook.cjs"
```

Then reload and restart your service:

```bash
systemctl --user daemon-reload
systemctl --user restart pi-web
```

The hook reads credentials from the service user's home, which may differ from your
interactive shell. With the Azure OpenAI configuration above, startup reports:

```text
[pi-web-voice] active · provider=azure-openai
```

## Diagnostics and troubleshooting

### If the microphone button is missing

Check the active hook path and reload the page after handling pending audio. The hook
injects into identity-encoded UTF-8 HTML from pi-web; configure that response format at
the application boundary. A reverse proxy can compress the response after injection.
Compressed or alternative-charset HTML reaching the hook passes through unchanged.

### Check the backend first

```bash
pi-web-voice doctor                  # generated one-second tone
pi-web-voice doctor recording.wav    # a WAV file you choose
```

Doctor prints resolved settings with the key masked, vocabulary examples, and a
transcript or diagnosis. An empty result from the generated tone can be normal and
still demonstrates a successful backend call. Doctor uses the configured provider and
may incur charges. In mock mode its checks cover local processing only. Use browser
checks for microphone capture and end-to-end checks for your production proxy path.
Review output before sharing: doctor includes paths, endpoint, vocabulary, transcript,
and potentially detailed errors.

Typical backend responses:

| Status / symptom | Check |
| --- | --- |
| 401 | Key and resource pairing |
| 403 | Service permissions and resource access |
| 404 | Endpoint, deployment, and model availability in the region |
| 400 | Model/API version, request format, or unsupported audio/parameters |
| 429 | Quota and rate limits |
| Fetch failure / timeout | DNS, network, provider reachability, and proxy timeouts |

### Identify the failure source

Notices identify the source in English or Chinese using the browser language. HTTP
notices include the status and a validated `x-pi-voice-request-id` when available.
The status remains visible when the response omits the request ID.

These labels describe the browser's request to `/__voice/transcribe`. The hook returns
HTTP **502** for caught transcription failures, including an upstream 401 or 429. Use
the error detail and the log's `upstream_status` to distinguish provider responses from
transport or gateway failures.

| Notice | Meaning and next step | Transcription request/log? |
| --- | --- | --- |
| `Client · microphone` / `Client · audio` | Permission, startup, or audio-context activation failure; check permissions/HTTPS, then try again | Local processing only |
| `Client · recording` | Capture yields zero samples; inspect the pre-stop audio state and try recording again | Local processing only |
| `Network` | Upload or response-reading failure; retry the retained take and check connectivity | The server may complete the attempt despite the client failure |
| `Server` | HTTP error response; inspect status, structured error detail, and request ID | HTTP response available |
| `Server response` | Successful HTTP status with an empty/invalid body or missing/non-string `text`; retry and investigate the server/proxy | Response requires format investigation |
| `Server · empty transcript` | Valid response contains empty text; review the audio and provider behavior | Successful completion with `0 chars` |
| `Client · conversation` / `Client · composer` / `Client` | Local result-handling failure; return to the Stop-time conversation or restore its composer | Cached text supports local recovery |

The browser accepts `{"text":""}` as a successful empty transcription and clears the
pending take. An empty HTTP 200/204 body is a response-format error and retains the take
for Retry. Assess silence and VAD behavior separately from the empty-text result.

### Non-JSON responses and HTTP 502

The browser describes HTML, plaintext, malformed JSON, and empty bodies with stable
format explanations and the HTTP status. For example:

```text
[Server] Transcription request failed (HTTP 502): Server or gateway returned HTML instead of JSON; recording kept for retry
```

Structured JSON error strings remain visible, even with a wrong/missing Content-Type.
For a non-JSON response received directly by the browser, the handler limits the notice
to its format, status, and validated request ID. Upstream error bodies wrapped by the
hook in a JSON `error` string can appear as plain text; review details before sharing.
A response-read interruption uses a network/read label and preserves any known status.
Use request evidence to locate the failure and diagnose provider availability separately.

### Safari after backgrounding or switching tabs

The maintainer uses pi-web-voice on iPhone Safari and as an installed home-screen web
app (PWA). Each take owns a new audio context, and Stop closes it. A fresh context can
still need a bounded resume before capture. Treat this lifecycle as an isolation measure;
real-device use determines whether it prevents a particular browser audio failure.

The iOS 26.6.1 home-screen PWA report describes repeated zero-sample errors while the
clock advances and the pre-stop context reports `running`. Switching the app to the
background and returning restores recording without an observed page reload. This is
a reproduction report, rather than confirmation of a specific WebKit defect or fix.
The maintainer confirms normal voice input with per-take contexts in the
[2026-09-08 validation](DEVELOPMENT.md#manual-verification); continuing daily use assesses
recurrence of the intermittent failure.

After a client capture error, stop recording, switch the app to the background, return,
and try a new take. Foregrounding alone keeps the microphone closed. If capture still
fails, recover any pending take, then close and reopen the page. Keep website data intact
during these recovery steps. Use script/request evidence when investigating caching;
reload an open page to execute updated client code.

Assess authentication from requests made by the affected app. An installed iOS PWA has
separate cookies and storage from Safari; a successful Safari login alone does not verify
the PWA's session. Zero-sample errors remain local and produce no transcription POST or
backend log. See [failure sources](#identify-the-failure-source) for upload/authentication
and response errors.

## Logs and diagnostic endpoints

### Transcription logs

Each transcription POST gets a UTC start timestamp and its own request ID. The hook
returns that ID in `x-pi-voice-request-id`; match the browser Network header to the log.
`<uuid>` is a placeholder in these examples:

```text
[pi-web-voice] 2026-09-07T20:32:00.000Z · request=<uuid> · audio_context=per-take · provider=azure-openai · vad=auto · result=empty · 0.5s · 3.0s audio · 60 terms · 0 chars · en
[pi-web-voice] 2026-09-07T20:33:00.000Z · request=<uuid> · audio_context=per-take · provider=azure-openai · vad=auto · result=transcribed · 1.2s · 4.6s audio · 37 terms · 58 chars · zh/en · mic opened in 340ms
```

| Field | Interpretation |
| --- | --- |
| `audio_context=per-take` | The client declares one fresh context per take; Retry retains that original capture policy |
| `audio_context=unspecified` | The request omits the recognized policy marker, as with an older open page or a direct API caller |
| `vad=auto` | The selected backend/model branch is configured to request automatic VAD |
| `vad=default` | The selected branch leaves VAD behavior to the provider's defaults |
| `result=empty` | The response contains empty text; assess its cause from the audio and provider behavior |
| `result=transcribed` | The provider returns text; confirm insertion in the browser separately |
| `result=rejected · reason=empty-audio` | The server rejects a zero-byte upload |
| `result=error`, `upstream_status=…` | Failure with an upstream HTTP status, or `n/a` when that status is unavailable |
| Elapsed seconds | Route elapsed time, including upload reading and backend work |
| Audio seconds / terms / chars / languages | Estimated duration from PCM bytes, vocabulary/text counts, and language hints |
| `mic opened in …ms` | Accepted activation to microphone/audio-graph readiness |

The hook computes the VAD and audio-context labels before upload validation, so both
also appear on upload rejections and caught failures. The audio-context field accepts
only the fixed `per-take` marker; all other values become `unspecified`. It describes a
client-reported policy, not server verification of context creation or audio health.
The VAD field records request configuration; outcome fields describe processing results.

Microphone timing starts at accepted activation after replacement confirmation and ends
at audio-graph readiness. Pointer-hold time is outside that interval. Retry reuses the
original take's measurement while keeping the microphone and audio context closed.
Fresh-context setup and any wait for a preceding close are part of this measurement.
Compare timings with the same measurement origin and capture policy.

Each uploaded retry is a **new POST and request ID**. Correlate requests through their
IDs and the browser's request sequence; durations alone identify only an approximate
audio length. A lost response can follow successful server processing. Only uploads
create transcription request logs; cached-text insertion and capture cancellation remain
client-local.

The request-log schema contains metadata only: timestamps, request IDs, audio-context
policy, provider/VAD/outcome/status fields, timings, counts, and language hints. Detailed
errors remain part of the caller's response. Provider billing also applies to successful empty results.

### Health and vocabulary inspection

```bash
curl 'http://127.0.0.1:30141/__voice/health'
curl 'http://127.0.0.1:30141/__voice/terms?session=<id>'
curl 'http://127.0.0.1:30141/__voice/terms?cwd=/path/to/project'
```

Replace placeholders and URL-encode real paths/IDs as needed. Health reports the active
provider configuration; use `doctor` to check the configured speech service. The terms
endpoint shows vocabulary a matching session/project supplies, including the requested
ID and working directory. Treat this as private project information: protect the endpoint
with access control and share only redacted diagnostic output.

## Privacy and access control

- Audio travels from the browser to your pi-web origin and then to the configured
  transcription backend. Conversation-derived vocabulary can accompany it. Mock
  generates its response locally.
- Vocabulary extraction reads only user/assistant prose and skips thinking blocks,
  tool arguments, and tool results. Credential filtering covers specific token-like
  shapes. Inspect the resulting terms to assess sensitive content beyond those patterns.
- Browser configuration contains only the route prefix and provider. File-based
  credentials stay in a private server object; explicitly exported service variables
  retain their normal child-process inheritance.
- This add-on keeps recordings and transcripts in memory. Pending data lives in the page;
  sending text afterward follows pi-web's normal conversation handling. Speech-provider
  retention, browser behavior, and external proxy logs have separate policies.
- Transcription request logs are metadata-only. Doctor output, diagnostic endpoints,
  structured errors, and infrastructure logs can contain more detail. Request URLs carry
  session/working-directory parameters that a proxy may log independently.
- Serve voice routes through a private origin or an access-control layer in front of
  the hook. The hook answers `/__voice/` before pi-web's application handlers, so these
  routes need protection at the pre-hook layer. Pair HTTPS encryption with this access
  control to protect both transport and entry to the service.

## Upgrading and uninstalling

Check [CHANGELOG.md](CHANGELOG.md) for changes before updating:

```bash
npm update -g pi-web-voice    # registry installation
npm update -g @agegr/pi-web
```

For a source installation, update your checkout and reinstall it with `npm install -g .`.
The hook preserves pi-web's installed files; package updates retain this external
integration. Check compatibility after updating pi-web.

Update the installation the service actually loads. Check the service's `NODE_OPTIONS`
and the path from `hook-path` to identify that copy. Client script changes require a
page reload; backend/configuration changes require a service restart. The injected
script uses `Cache-Control: no-store`, while an open page keeps executing its existing
copy. Retry pending audio before refreshing or redeploying.

To disable voice input, remove its `--require` from the service's `NODE_OPTIONS` and
reload/restart the service, or stop launching through `pi-web-voice`. Refresh open pages
to remove the injected controls. Optionally uninstall the package:

```bash
npm uninstall -g pi-web-voice
```

pi-web's installed files stay intact. The separate `~/.pi/agent/voice.env` remains;
keep or remove it according to your continuing need for those settings and credentials.
