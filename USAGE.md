# Usage guide

For installation in a few steps, start with the [README](README.md). This guide covers
configuration, daily use, deployment, and troubleshooting. Implementation and test
details belong in [DEVELOPMENT.md](DEVELOPMENT.md).

## Installation and requirements

The runtime requires Node.js 20+, a working `pi-web` command, and a browser that supports
microphone capture and Web Audio. The documented integration was verified against
pi-web `0.9.0` (pi `0.85.1`); other versions may require compatibility checks.
Browser-based developer tests have additional requirements, described in
[Development and testing](DEVELOPMENT.md#development-and-testing).

```bash
npm install -g @agegr/pi-web   # if pi-web is not already installed
npm install -g pi-web-voice
pi-web-voice init
```

Fill in one backend in the generated configuration file, then run:

```bash
pi-web-voice doctor
pi-web-voice
```

There is no build step and no third-party runtime dependency. `npx pi-web-voice` also
works when pi-web is already installed. All non-command arguments pass through to
pi-web; for example, `pi-web-voice -p 8080`.

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
leaves an existing file untouched.

The hook uses a small, private line parser; it does **not** load the file into
`process.env`. It accepts `KEY=value`, optional `export`, matching outer single/double
quotes, blank lines, and full-line `#` comments. It is not a shell: do not use variable
expansion, command substitution, or trailing inline comments.

An existing environment value takes precedence over the file, including an empty
exported value. Values read from the file are cached in the process: **restart the
service after changing configuration**. On Unix, keep its permissions restricted:

```bash
chmod 600 ~/.pi/agent/voice.env
```

Use the file rather than putting secret values in command lines or shell history.
Credentials exported into the service environment can also be inherited by its children;
the private-file loader does not remove values you exported yourself.

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

Without an explicit provider, nonempty keys select Azure Speech first, then Azure
OpenAI, then OpenAI; no key selects mock. Setting only an endpoint does not select a
backend. Set `PI_VOICE_PROVIDER` to break a tie or to use a keyless local service.

Route prefix, API-version defaults, recording/upload limits, and vocabulary budgets are
implementation constants, not additional environment switches. See
[Runtime constants](DEVELOPMENT.md#runtime-constants).

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

Prefer the complete transcriptions URL for your actual deployment from the Azure portal.
The example is a URL shape, not a promise that every resource serves that model/API version.
A complete URL is used as supplied, including its `api-version`. Bare resource names and
resource roots are also accepted; the hook then constructs a deployment URL using its
built-in API-version default.

Deployment-style and `/openai/v1/audio/transcriptions` URLs are supported. A model field
is included for the v1 form. Set `PI_VOICE_DEPLOYMENT` to the actual deployment name even
when supplying a full URL: the hook chooses the structured branch when either the URL
or that setting contains `gpt-transcribe`. It does not discover the deployed model from Azure.

- `gpt-transcribe` uses structured vocabulary/language hints and requests automatic
  VAD with `chunking_strategy=auto`; a keyword-to-prompt fallback retains VAD.
- For `gpt-4o-transcribe` or whisper, update both endpoint and deployment setting rather
  than leaving the `gpt-transcribe` default. Their branch uses a bounded vocabulary
  prompt and sends no VAD override.

There is no fixed recognition-language setting. The structured Azure OpenAI branch gets
up to three language hints from the browser's `Accept-Language`; English is appended as
a fallback if it fits within that limit. A valid empty transcription leaves the draft
untouched; it does not prove silence or VAD filtering. Audio still reaches the provider
and can incur usage charges.

### Azure AI Speech

This optional backend is separate from Azure OpenAI. Use `azure-speech` for
MAI-Transcribe-2 fast transcription with automatic language identification, code
switching, and vocabulary supplied as `phraseList.phrases`.

```sh
PI_VOICE_PROVIDER=azure-speech
AZURE_SPEECH_ENDPOINT=https://my-resource.cognitiveservices.azure.com
AZURE_SPEECH_KEY=your-resource-key
```

A bare resource name is expanded to a `cognitiveservices.azure.com` URL. This setting
expects the resource root, not the full transcription operation URL.

**Region support matters.** The project's existing setup notes list `eastus`,
`northeurope`, `southeastasia`, `westus`, and `westus2` for MAI-Transcribe. Verify current
availability for the resource/model before provisioning, then use `doctor` to check it.
A valid key alone does not establish model availability in that region.

For example, with Azure CLI and an existing resource group:

```bash
az cognitiveservices account create --name my-speech --resource-group my-rg \
  --kind AIServices --sku S0 --location westus2 --yes
az cognitiveservices account show --name my-speech --resource-group my-rg \
  --query properties.endpoint -o tsv
az cognitiveservices account keys list --name my-speech --resource-group my-rg \
  --query key1 -o tsv
```

The last command prints a secret; do not share its output. The application currently
limits this backend to **50 single-word vocabulary terms**, not a generic 500-entry
allowance. The rationale and historical measurements are in
[Vocabulary limits](DEVELOPMENT.md#vocabulary-extraction-and-limits).

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
set its API root and model, explicitly select `PI_VOICE_PROVIDER=openai`, and leave the
key empty if the server does not require one. The service must accept the OpenAI-style
multipart `/audio/transcriptions` request; the hook appends that path to the base URL.

### Mock

```bash
PI_VOICE_PROVIDER=mock pi-web-voice
```

This inline environment syntax is for POSIX shells. In PowerShell, set
`$env:PI_VOICE_PROVIDER = 'mock'` before running `pi-web-voice`, or set the provider in
`voice.env` as in the README.

Mock makes no speech-provider request. It returns diagnostic text describing the received
audio and, when available, some mined vocabulary. It tests the button, recorder, and
round trip; it does not recognize speech. Browser microphone permissions still apply.

## Recording and retry

### Starting and stopping

Click the microphone next to image attachment, wait for `…` to become a clock, then
speak. Click again to stop. The clock indicates microphone/audio-graph readiness, not
a guarantee of uninterrupted sample delivery on every browser/device.

The current source opens the microphone only on click, not on pointer-down. Holding,
sliding off, or abandoning a pointer gesture does not open it. Keyboard/VoiceOver
activation, `Cmd/Ctrl+Shift+V`, and supported headphone media controls use the same
start/stop controller.

Clicking again during opening cancels the take. Browser permission requests cannot be
aborted, so the button may remain disabled with **Cancelling microphone request** until
the request settles and any late stream is closed. Wait rather than repeatedly pressing.
Only one opening is allowed per page; other tabs have their own controller.

Stopping releases the microphone. With audio callbacks running, a take stops automatically
after approximately **10 minutes**, then transcribes normally. Browser audio is 16 kHz
mono PCM WAV; a full-length take is about 19.2 MB, below the 25 MiB server upload ceiling.
Each upstream fetch has a 10-minute timeout until response headers arrive. This is not
an end-to-end deadline: body reading is outside that timer, and a compatibility fallback
starts another attempt. Proxies and the host server may impose their own limits.

### Retry and conversation changes

On a retryable failure, the original red error notice stays visible with an underlined
**Retry** action. It resubmits the same WAV without opening the microphone. The action
is disabled while transcribing; another failure updates the same notice, and success
clears the pending take. The browser never automatically resubmits failed uploads.
Backend parameter-compatibility fallbacks within a request are described in
[Development](DEVELOPMENT.md#provider-requests-and-fallbacks).

Only one pending take is held in page memory:

- Refreshing, closing, or browser page discard loses it. **Retry before reloading.**
- Starting a new take asks before replacement. Denied microphone access or a cancelled
  opening preserves the previous pending take.
- The pending take captures the page's reported session and working directory **when
  recording stops**, not when it starts. Stay in the same conversation while recording;
  after stopping, return to that conversation before retrying.
- If text was received but the composer was unavailable or the conversation changed,
  the text is retained. Local recovery inserts it without another provider request.
- An explicitly empty transcript is a successful server result, not a retryable error.
  It leaves the draft alone and shows a server-empty-result notice.

Each uploaded retry may incur another provider charge, even when an earlier response
was lost after successful processing. Ordinary non-retryable notices disappear after
four seconds; retryable notices remain until handled.

## Deployment and remote access

### HTTPS and access control

Microphone capture requires HTTPS or a browser-trusted loopback origin. `http://localhost`
and `http://127.0.0.1` work; ordinary LAN HTTP such as `http://192.168.1.10:30141` does not.

| Situation | Approach |
| --- | --- |
| Remote machine, desktop client | Use `ssh -L 30141:127.0.0.1:30141 host`, then open `http://localhost:30141` |
| Phone/tablet or LAN access | Use HTTPS via an access-controlled proxy, [Tailscale Serve](https://tailscale.com/kb/1312/serve), or Caddy with a certificate trusted by the device |
| Desktop Chromium testing only | A temporary `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.10:30141` override can help isolate HTTPS issues; do not use it as production deployment guidance |

For iOS Safari, use a certificate trusted by the device rather than relying on a desktop
browser override. HTTPS is not authentication: keep the origin private or protect it,
including `/__voice/`, with access control. See [Privacy and access control](#privacy-and-access-control).

### Running as a service

If pi-web already runs under launchd or systemd, add the hook to its `NODE_OPTIONS`
instead of replacing its launch command. Find the installed path with:

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

`launchctl kickstart -k` uses launchd's in-memory definition and does not load plist
changes. A child `next start` process can retain the port; inspect it rather than
killing unrelated Node/Next.js processes.

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

### Check the backend first

```bash
pi-web-voice doctor                  # generated one-second tone
pi-web-voice doctor recording.wav    # a WAV file you choose
```

Doctor prints the resolved settings with the key masked, vocabulary examples, and a
transcript or diagnosis. An empty result from the generated tone can be normal and
still demonstrates a successful backend call. Doctor uses the configured provider and
may incur charges; it does not test the browser microphone or every production proxy.
In mock mode it does not validate speech credentials or contact an upstream service.
Review its output before sharing: unlike request logs, it includes paths, endpoint,
vocabulary, transcript, and possibly detailed errors.

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

Current notices identify the source in English or Chinese using the browser language.
HTTP notices include the status and a validated `x-pi-voice-request-id` when available;
older hook installations without that header still show the status.

These labels describe the browser's request to `/__voice/transcribe`. The hook returns
HTTP **502** for caught transcription failures, including an upstream 401 or 429. Look
at the error detail and the log's `upstream_status` for the provider status; a browser
502 by itself does not identify a gateway outage.

| Notice | Meaning and next step | Transcription request/log? |
| --- | --- | --- |
| `Client · microphone` / `Client · audio` | Permission, startup, or audio-context activation failed; check permissions/HTTPS, then try again | No audio uploaded |
| `Client · recording` | No samples captured; inspect the reported pre-stop audio state and try recording again | Nothing uploaded |
| `Network` | Upload or response reading failed; retry the retained take and check connectivity | Unknown: the server may already have processed it |
| `Server` | Non-success HTTP response; inspect status, structured error detail, and request ID | HTTP response received |
| `Server response` | Successful HTTP status but empty/invalid body or missing/non-string `text`; retry and investigate the server/proxy | Response received, but unusable |
| `Server · empty transcript` | Valid response explicitly returned empty text; review the audio/provider rather than assuming a transport failure | Successful completion with `0 chars` |
| `Client · conversation` / `Client · composer` / `Client` | Local result handling failed; return to the conversation saved at Stop or restore its composer | Cached text may recover without another request |

A valid `{"text":""}` is not the same as an empty HTTP 200/204 body. The former clears
the pending take as a successful empty transcription; the latter retains it for Retry.
An empty transcript does not prove the user was silent or VAD rejected the recording.

### Non-JSON responses and HTTP 502

HTML, plaintext, malformed JSON, and empty bodies receive stable explanations rather
than browser parser exceptions such as Safari's “The string did not match the expected
pattern.” For example:

```text
[Server] Transcription request failed (HTTP 502): Server or gateway returned HTML instead of JSON; recording kept for retry
```

Structured JSON error strings remain visible, even with a wrong/missing Content-Type.
For a non-JSON response received directly by the browser, the handler shows a format
explanation rather than its raw body or arbitrary headers. Upstream error bodies wrapped
by the hook in a JSON `error` string can still appear as plain text; review details before
sharing them. A response-read interruption remains a network/read failure while preserving
any known status. This improves diagnosis, not provider availability; use request evidence
to identify where a failure originated.

### Safari after backgrounding or switching tabs

The maintainer has validated pi-web-voice through long-term daily use on iPhone Safari.
For audio interruptions, the recorder resumes interrupted/suspended contexts, replaces
closed contexts, and rebuilds the context after zero captured samples.

Try recording again after a client-side capture error. If it persists, close and reopen
the page, but recover any pending take first. Do not clear website data as the first
step. Reopening also recreates audio state, so recovery after a reload is not proof of
a stale-script cache. An already open page does need a reload to run updated client code.

## Logs and diagnostic endpoints

### Transcription logs

Each transcription POST gets a UTC start timestamp and its own request ID, also returned
in `x-pi-voice-request-id`. Match that header in the browser Network panel to the log.
`<uuid>` is a placeholder in these examples:

```text
[pi-web-voice] 2026-09-07T20:32:00.000Z · request=<uuid> · provider=azure-openai · vad=auto · result=empty · 0.5s · 3.0s audio · 60 terms · 0 chars · en
[pi-web-voice] 2026-09-07T20:33:00.000Z · request=<uuid> · provider=azure-openai · vad=auto · result=transcribed · 1.2s · 4.6s audio · 37 terms · 58 chars · zh/en · mic opened in 340ms
```

| Field | Interpretation |
| --- | --- |
| `vad=auto` | The selected backend/model branch is configured to request automatic VAD |
| `vad=default` | The selected branch sends no VAD override; the provider may still use its own VAD |
| `result=empty` | Successful response without text; not proof of silence or VAD rejection |
| `result=transcribed` | Provider returned text; not proof the browser inserted it |
| `result=rejected · reason=empty-audio` | Server rejected a zero-byte upload |
| `result=error`, `upstream_status=…` | Failure with a separate upstream HTTP status, or `n/a` without one |
| Elapsed seconds | Request time, not just model inference |
| Audio seconds / terms / chars / languages | Estimated duration from PCM bytes, vocabulary/text counts, and language hints |
| `mic opened in …ms` | Accepted activation to microphone/audio-graph readiness in the current source |

The VAD label is computed before upload validation, so it also appears for rejected
uploads that never reach a provider. It describes request configuration, not a reported
filtering decision.

The microphone timing now excludes pointer-hold time and replacement confirmation; the
old pre-warm implementation measured from finger-down. The field name did not change,
so do not interpret the changed time origin as a capture speedup. Retry reuses the
original take's timing, not a new microphone opening.

Each uploaded retry is a **new POST and request ID**. There is no shared recording ID or
audio fingerprint; equal durations do not prove two entries are the same take. A lost
response may follow a successful server log. Cached-text insertion, abandoned gestures,
and client-only capture failures do not create a new transcription log.

Request logs contain metadata, not recordings, transcripts, vocabulary lists, keys,
session IDs, working directories, or raw upstream error bodies. Detailed service errors
can still reach the requesting browser. An empty result is not a billing exemption.

### Health and vocabulary inspection

```bash
curl 'http://127.0.0.1:30141/__voice/health'
curl 'http://127.0.0.1:30141/__voice/terms?session=<id>'
curl 'http://127.0.0.1:30141/__voice/terms?cwd=/path/to/project'
```

Replace placeholders and URL-encode real paths/IDs as needed. Health reports the active
provider; it is **not** a credential or upstream connectivity test. The terms endpoint
shows vocabulary a matching session/project would supply, including the requested ID
and working directory. It can expose private project information; do not publish its
output or expose the endpoint without access control.

## Privacy and access control

- Audio travels from the browser to your pi-web origin and then to the configured
  transcription backend. Conversation-derived vocabulary can accompany it. Mock does
  not call an upstream speech service.
- Only user/assistant text is mined, not thinking blocks, tool arguments, or tool results.
  Candidate filtering drops several credential-like shapes, but is **heuristic, not a
  guarantee that all sensitive terms are removed**. Inspect terms when privacy matters.
- The hook does not put API keys in browser configuration. File-based credentials stay
  in a private server object, rather than being added to every child process environment.
- pi-web-voice does not persist recordings or transcripts to disk. Pending data is held
  in page memory; sending text afterward follows pi-web's normal conversation handling.
  Speech-provider retention, browser behavior, and external proxy logs are separate.
- Transcription request logs are metadata-only. Doctor output, diagnostic endpoints,
  structured errors, and infrastructure logs can contain more detail. Request URLs carry
  session/working-directory parameters that a proxy may log independently.
- The hook answers `/__voice/` before pi-web's application handlers and adds no
  authentication of its own. Do not assume application-level login protects these routes.
  Keep the service private or protect the entire origin, including voice routes, at an
  appropriate access-control layer. HTTPS alone is not access control.

## Upgrading and uninstalling

Check [CHANGELOG.md](CHANGELOG.md) for changes before updating:

```bash
npm update -g pi-web-voice    # registry installation
npm update -g @agegr/pi-web
```

For a source installation, update your checkout and reinstall it with `npm install -g .`.
The hook does not edit pi-web's installed files, so a pi-web update needs no patch
reapplication, but compatibility should still be checked.

The active installation matters: editing a checkout does not necessarily update a
separate global copy. Check the service's `NODE_OPTIONS` and the path from `hook-path`.
Client script changes require reloading the page; backend/configuration changes require
restarting the service. The injected script is served with `Cache-Control: no-store`,
but an already open page keeps executing its existing copy. Retry pending audio before
refreshing or redeploying.

To disable voice input, remove its `--require` from the service's `NODE_OPTIONS` and
reload/restart the service, or stop launching through `pi-web-voice`. Refresh open pages
to remove the injected controls. Optionally uninstall the package:

```bash
npm uninstall -g pi-web-voice
```

No pi-web source files need reverting. The separate `~/.pi/agent/voice.env` remains;
remove it yourself if you no longer need those settings and credentials.
