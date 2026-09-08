# pi-web-voice

Voice input for [pi-web](https://github.com/agegr/pi-web), added from the outside.

A microphone button appears in the chat composer. Click it to start, click again to stop;
the clock that appears is the cue that the microphone is open. The transcript lands at
your caret; you review it, then send. Keyboard, VoiceOver and the accessibility API can
press it too. pi-web is never modified: the whole thing is one `--require` hook that
injects a single `<script>` tag into HTML responses and answers its own requests under
`/__voice/`.

```
you speak ──▶ browser records 16 kHz WAV ──▶ POST /__voice/transcribe
                                                    │
                                    Azure AI Speech (MAI-Transcribe-2)
                                    Azure OpenAI (gpt-4o-transcribe)
                                    OpenAI · Groq · local whisper.cpp
                                                    │
                          transcript ◀──────────────┘  inserted at the caret
```

**Why a hook instead of a fork:** pi-web ships as a prebuilt Next.js app with no source
in the npm package, so there is nothing to patch cleanly. This attaches at the Node
layer instead, which means `npm update -g @agegr/pi-web` needs no re-apply.

## Quick start

```bash
npm install -g pi-web-voice

pi-web-voice init      # writes ~/.pi/agent/voice.env, mode 0600
                       # uncomment one backend in it and add the key
pi-web-voice doctor    # proves the key, region and model before you look for a mic bug
pi-web-voice           # starts pi-web with the microphone button
```

`pi-web-voice` starts pi-web with the hook and passes every argument through, so
`pi-web-voice -p 8080` works. With no key at all it runs a mock backend, which is enough
to prove the button and the round trip.

Nothing is compiled and there are no dependencies, so `npx pi-web-voice` works too, and a
`git clone` plus `npm install -g .` works if you would rather run from source.

You should see this on startup, and a microphone next to the image-attach button:

```
[pi-web-voice] active · provider=azure-speech · context=project
```

## Running it as a service

If pi-web already runs under launchd or systemd, add one environment variable to the
service rather than changing how it starts. `hook-path` prints the value regardless of
where npm installed the package:

```bash
pi-web-voice hook-path
#   /opt/homebrew/lib/node_modules/pi-web-voice/hook.cjs
```

launchd — add to `EnvironmentVariables` in the plist, then reload it:

```xml
<key>NODE_OPTIONS</key>
<string>--require /opt/homebrew/lib/node_modules/pi-web-voice/hook.cjs</string>
```

```bash
launchctl bootout gui/$(id -u)/com.agegr.pi-web
lsof -ti:30141 | xargs kill -9 2>/dev/null; pkill -f next-server; sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agegr.pi-web.plist
```

`launchctl kickstart -k` restarts the job from launchd's in-memory copy and will **not**
pick up plist changes. It also leaves the `next start` child orphaned holding the port,
which is what the second line clears.

systemd — `Environment=NODE_OPTIONS=--require /path/to/hook.cjs`, then
`systemctl --user daemon-reload && systemctl --user restart pi-web`.

Removing that one variable disables everything; pi-web itself was never modified.

## Where the key goes

`~/.pi/agent/voice.env`, next to pi's own configuration. It is a plain `KEY=value`
file, loaded by Node itself — no dependency, no parser of ours:

```sh
AZURE_SPEECH_ENDPOINT=https://my-resource.cognitiveservices.azure.com
AZURE_SPEECH_KEY=abc123...
PI_VOICE_PROVIDER=azure-speech
```

Anything already exported wins over the file, so `AZURE_SPEECH_KEY=other pi-web-voice`
overrides it for one run without editing anything. Keep it `chmod 600`; the hook warns
if it is not.

## ⚠️ The microphone needs HTTPS or localhost

This is a browser rule, not something this project can work around. `http://localhost`
and `http://127.0.0.1` are fine. **A plain-HTTP LAN address such as
`http://192.168.1.10:30141` is not** — the button will report that the microphone is
unavailable. Pick one:

| Situation | Fix |
| --- | --- |
| Remote machine, you are on a desktop | `ssh -L 30141:127.0.0.1:30141 host` and use `http://localhost:30141` |
| Phone or tablet on your LAN | Terminate HTTPS in front: [Tailscale Serve](https://tailscale.com/kb/1312/serve), Caddy with an internal CA, or any reverse proxy with a certificate |
| Desktop Chrome/Edge, testing only | Launch with `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.10:30141` |

iOS Safari has no override, so a real certificate is the only path there.

## When to start talking

The button turns red the instant you press it, but the microphone is not open yet:
`getUserMedia` and the audio session take a few hundred milliseconds on a phone, and no
audio exists before the browser hands the stream over. Anything said in that window is
gone — not dropped by pi-web-voice, never recorded at all.

So the button says which is which. `…` means the press landed and the microphone is
opening. The clock replacing it — `0:00`, with the icon pulsing — means the microphone
and audio graph are ready. **Wait for the digits before talking.** The clock excludes the
opening delay, but it is not a guarantee that a browser/device interruption cannot stop
samples arriving; those failures are reported separately below.

The wait is real, so it is measured rather than guessed. Each [transcription log](#transcription-logs)
includes `mic opened in 340ms` when the browser reports that measurement.

### Click-only microphone lifecycle

The microphone button opens audio only on **click**, not on `pointerdown`. Holding a finger
on it, sliding off, or abandoning a touch does not request microphone access. There is no
pre-warmed stream, expiry timer or automatic second opening after an error. Keyboard,
VoiceOver and headphone controls continue to use the same guarded start/stop controller.

Each accepted activation makes one `getUserMedia` request. Clicking again while it is opening
cancels the take, but browser permission requests cannot be aborted. The button temporarily
shows "Cancelling microphone request" and is disabled until that request settles and any late
stream is closed. Further presses cannot open a second stream during that wait. This guard
is per page; it does not prevent recording deliberately in a different tab.

Stopping releases the microphone; Retry only resubmits the stored WAV. A healthy audio context
is still reused and suspended between takes to avoid repeated audio-session startup. Safari
interruption recovery and reset after zero samples remain in place.

A take can run for up to **10 minutes**. At `10:00` it stops and starts transcribing just
as if the button had been clicked; there is no separate warning or confirmation. The
resulting 16 kHz mono PCM WAV is about 19.2 MB, below the 25 MB Azure OpenAI upload limit.
The server allows the backend up to another 10 minutes to finish a long transcription.

### Retry a failed transcription

If uploading or transcribing fails, the original red error notice keeps the full error
message with an underlined **Retry** text action beside it — no separate border or background.
It retains button semantics, keyboard focus and a 44 × 44 px minimum touch target. The notice
stays until the recording is handled, rather than disappearing after four seconds. Retry
resubmits the same WAV without opening the microphone or asking you to speak again. While
retrying, the error remains visible and the action is disabled with a "Transcribing…" label.

Repeated failures update that same notice and keep the recording available; success clears
the recording and removes the notice. Requests are never retried automatically, and repeated
clicks cannot send parallel attempts. Successful empty responses show an explicit
**server empty transcript** notice without a retry; ordinary notices still disappear after
four seconds.

Only the pending take is kept, in this page's memory — not on disk. Refreshing, closing,
or the browser discarding/reloading the page loses it; retry before doing any of those.
Starting a new recording asks before replacing a pending one; a denied microphone or a
cancelled opening leaves the old take available. If you switch conversations,
return to the original one to retry. A transcript with no available composer is retained too,
so retrying once the composer returns inserts the cached text without another service call.

### Identify where a failure happened

The old "No speech detected" notice conflated two different paths. Notices now identify the
source in English or Chinese, using the browser's language:

| Notice prefix | Meaning | Server request/log? |
| --- | --- | --- |
| `Client · microphone` / `Client · audio` | Permission, microphone startup, or audio-context activation failed | No audio uploaded |
| `Client · recording` | Zero audio samples captured; the notice includes the pre-stop `AudioContext` state | Nothing uploaded, so no transcription log |
| `Network` | Fetch failed or reading the response was interrupted; audio remains available for Retry | Unknown; the server may already have processed it |
| `Server` | A non-success HTTP response; the notice retains its status and available error details | An HTTP response was received |
| `Server response` | Invalid JSON or a missing/non-string `text` field; audio is kept for Retry | Response received, but unusable |
| `Server · empty transcript` | A valid response explicitly returned empty text after audio was submitted | Completion log with `0 chars`; not proof that VAD rejected speech |
| `Client · conversation` / `Client · composer` / `Client` | Local conversation/composer handling failed | Received text is retained for local recovery where available |

Server notices include the HTTP status and, when supplied by the installed backend, a validated
`x-pi-voice-request-id` for matching logs. Older backends without that header still show the
source and HTTP status. Client-only failures are not sent to a separate telemetry endpoint.

### Safari after switching tabs or returning from the background

Closing and reopening a Safari page also recreates its microphone/audio state; recovery after
that is not proof of a stale-script cache. The injected script is served with `Cache-Control:
no-store`, though an already open page needs a reload to execute an updated script.

[iOS Safari can leave an AudioContext in `interrupted` state](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state#resuming_interrupted_play_states_in_ios_safari).
Before recording, both interrupted and suspended contexts are resumed and must reach `running`.
A closed context is replaced. Resume attempts are bounded to three seconds; failure releases
the microphone and reports a client-side audio error instead of leaving the UI stuck opening.
A context that produces no samples is also discarded so the next take starts with a fresh one.
This handles known lifecycle cases but does not establish the cause of every Safari failure;
physical iPhone retesting is still needed. Do not clear website data as a first troubleshooting step.

## Backends

Set `PI_VOICE_PROVIDER`, or let it be inferred from whichever credentials exist.

### `azure-speech` — Azure AI Speech fast transcription (recommended)

Runs MAI-Transcribe-2, which does automatic language identification, code switching,
and **keyword biasing** — the combination that matters when you mix Chinese and English
and say project names out loud. The mined vocabulary is sent as `phraseList.phrases`,
which takes up to 500 entries, so the whole list fits.

> **Region matters.** MAI-Transcribe is only served from `eastus`, `northeurope`,
> `southeastasia`, `westus`, and `westus2`. A resource elsewhere is rejected. Create one
> in a supported region:
>
> ```bash
> az cognitiveservices account create --name my-speech --resource-group my-rg \
>   --kind AIServices --sku S0 --location westus2 --yes
> az cognitiveservices account show --name my-speech --resource-group my-rg \
>   --query properties.endpoint -o tsv
> az cognitiveservices account keys list --name my-speech --resource-group my-rg \
>   --query key1 -o tsv
> ```

| Variable | Default | Notes |
| --- | --- | --- |
| `AZURE_SPEECH_ENDPOINT` | — | Resource name or full `https://…cognitiveservices.azure.com` |
| `AZURE_SPEECH_KEY` | — | Resource key |

### `azure-openai` — gpt-transcribe, gpt-4o-transcribe, whisper

| Variable | Default |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | — |
| `AZURE_OPENAI_API_KEY` | — |
| `PI_VOICE_DEPLOYMENT` | `gpt-transcribe` |

The request shape follows the deployment name:

- **`gpt-transcribe`** gets the vocabulary as structured `keywords[]`, plus `languages[]`
  derived from the browser's `Accept-Language`. Deployment-style and v1 URLs are accepted.
  Requests set `chunking_strategy=auto` to enable the service's automatic VAD chunking,
  including when retrying with a prompt after keywords are rejected.
- **`gpt-4o-transcribe`** and whisper use the classic deployment path with a `prompt`.
  Whisper reads only the last 224 tokens of it, so the list is trimmed to fit. Note that
  `gpt-4o-transcribe` version `2025-03-20` retires on 15 October 2026.

#### Empty recordings and automatic VAD

Without VAD, `gpt-transcribe` can generate text from silence, influenced by the supplied
vocabulary. Explicitly requesting `chunking_strategy=auto` fixes the reproduced cases
without a browser model, new dependencies, or a fixed duration/loudness cutoff.

Live probes against the `2025-03-01-preview` deployment endpoint, with vocabulary enabled:

| Input | Observed result with automatic VAD |
| --- | --- |
| 0.2-second and three-second synthetic silence | Empty text; ungated controls generated unrelated English |
| Synthetic quiet noise and a click | Empty text |
| Synthesized English and Chinese speech | Transcribed, not discarded; ordinary recognition errors remain possible |
| Short words `Yes` and `好` | Recognized |
| Three seconds of silence followed by Chinese speech | Subsequent speech transcribed |

The deployed browser path was also checked with three-second silence and 60 terms, then
verified by manual use. These are observed results, not a guarantee for every microphone,
background voice or quiet utterance. Live probes are not part of `npm test`.

The parameter is a scalar multipart field, `chunking_strategy=auto`. On the tested endpoint,
invalid scalar values returned 400, while bracketed fields such as `chunking_strategy[type]`
were ignored. Keyword-to-prompt retries keep VAD enabled; there is no silent fallback that
removes it. An empty response leaves the draft and selection untouched and explicitly reports
that the **server returned no transcription text**, rather than claiming no speech was detected.

This is service-side filtering, not local cancellation: audio still reaches Azure, and
empty responses still report audio usage. No new VAD option is sent to other model branches.

### `openai` — OpenAI, Groq, or a local server

| Variable | Default |
| --- | --- |
| `PI_VOICE_OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | — |
| `PI_VOICE_OPENAI_MODEL` | `whisper-1` |

Groq: `PI_VOICE_OPENAI_BASE_URL=https://api.groq.com/openai/v1` with
`PI_VOICE_OPENAI_MODEL=whisper-large-v3`. A local `whisper.cpp` server works the same way.

### `mock`

Returns a fixed string describing the audio it received. Use it to confirm the button,
the recorder, and the round trip work before adding credentials.

## Check the backend before blaming the microphone

```bash
pi-web-voice doctor                  # sends a generated tone
pi-web-voice doctor recording.wav    # or your own audio
```

It prints the resolved settings with the key masked, the vocabulary it would send, and
either a transcript or a diagnosis — `401` wrong key, `404` wrong resource or region,
`400` a model that region does not serve. An empty transcript from the generated tone is
expected and still proves the credentials work.

## Transcription logs

Each transcription POST gets a UTC start timestamp and a unique request ID. The ID is also
returned in the `x-pi-voice-request-id` response header, so a browser Network entry can be
matched to its completion or failure log without storing the session ID or working directory.

Example completion logs (`<uuid>` stands for the response's request ID):

```text
[pi-web-voice] 2026-09-07T20:32:00.000Z · request=<uuid> · provider=azure-openai · vad=auto · result=empty · 0.5s · 3.0s audio · 60 terms · 0 chars · en
[pi-web-voice] 2026-09-07T20:33:00.000Z · request=<uuid> · provider=azure-openai · vad=auto · result=transcribed · 1.2s · 4.6s audio · 37 terms · 58 chars · zh/en · mic opened in 340ms
```

- **`vad=auto`** means the request explicitly enabled automatic VAD. **`vad=default`** means
  no override was sent; it does not claim the provider has no VAD internally.
- **`result=empty`** is a successful response with no text, not an error. It does **not**
  prove VAD filtered the audio: the service does not report that decision separately.
  **`result=transcribed`** means text was returned.
- **`result=rejected · reason=empty-audio`** means a zero-byte upload was rejected locally.
  **`result=error`** indicates a failed request, with `upstream_status=429`, for example,
  or `upstream_status=n/a` when no HTTP status is available.
- Elapsed time covers the request, not just model inference. Audio duration is estimated
  from the browser's 16 kHz mono PCM bytes. Term/character counts and language hints help
  explain results.
- **`mic opened in …ms`** now measures the accepted click/keyboard activation through microphone
  and audio-graph readiness, excluding time spent holding a pointer before clicking (and any
  replacement confirmation). The log field is unchanged, but the old pre-warm implementation
  measured from finger-down. Do not interpret that timing-origin change as a capture speedup.
  On Retry, this field is reused from the original recording; it does **not** mean the microphone
  was opened again. Abandoned gestures and cancelled openings produce no transcription request.

### Reading logs when retrying

- Each manual retry that uploads audio is a **new POST**, with its own request ID, elapsed
  time and completion/error entry. Match each attempt's `x-pi-voice-request-id` in the browser
  Network panel to the corresponding log. Uploading again may incur another provider charge.
- The logs do not contain a shared recording ID or an audio fingerprint. Equal audio durations
  alone do not prove two entries came from the same recording.
- A browser-side failure is not necessarily a server-side error: an upload may fail before
  reaching the server, or the response may be lost after the server logged `result=transcribed`.
  That result means the provider returned text, **not** that the browser inserted it successfully.
- If the transcript was already received but the composer was missing or the conversation
  changed, retry inserts the cached text. There is **no new POST, provider call or request log**
  for that local recovery.

Request logs contain metadata only: no audio, transcript, vocabulary list, session ID,
working directory, API key, or raw upstream error body. Detailed errors still reach the
requesting browser. VAD-only empty results can still incur provider usage; an empty transcript
is not a billing exemption.

## Vocabulary comes from your conversation

A hand-written term list goes stale the moment you start a new project, so the
vocabulary is mined per request instead:

1. The page reports which session the tab is showing, captured from pi-web's own
   `EventSource("/api/agent/<id>/events")` call, plus the working directory. No guessing
   from "most recent session".
2. The hook reads that session's JSONL — the same files pi-web reads — and scores terms
   with a distinctive written shape: `camelCase`, `kebab-case`, `file.ext`, `a/b/c`,
   acronyms, and short backtick spans. Ordinary words are skipped; a speech model gets
   those right already.
3. What you typed yourself counts more than what the assistant wrote, and recent text
   counts more than old text.
4. The conversation you are in outweighs the project's older ones. With no session yet,
   the project's history is all there is. With neither, nothing is sent — no invented
   vocabulary.

Ranking is by frequency, not recency. Recency was tried and measured worse: a few turns
on a side topic evicted the project's durable vocabulary, and the budget is small.

### Measured phrase-list limits

The published phrase-list guidance suggests up to 500 entries. Probing the West US
endpoint says otherwise:

| Model | Phrase list | `transcribeStyle` |
| --- | --- | --- |
| `MAI-Transcribe-2` | **50** | supported |
| `MAI-Transcribe-1.5` | **200** | rejected |
| `MAI-Transcribe-1` | not supported at all | rejected |

The count is of **words, not entries** — a two-word phrase costs two slots — so only
single-word terms are mined, and a rejected vocabulary is retried once without the
phrase list rather than losing the recording.

MAI-Transcribe-2 is preferred over 1.5 despite the smaller budget, because the larger one
does not buy anything: on the same recording, 1.5 with 200 terms produced `hook c js` and
`phrase list`, worse than its own no-vocabulary baseline and twice as slow.

### Backends measured against each other

Three Chinese-English sentences full of identifiers, same mined vocabulary, list prices:

| | MAI-Transcribe-2 | gpt-transcribe |
| --- | --- | --- |
| Exact technical strings | good | **better** — the only one to get `MAI-Transcribe-2` intact |
| Punctuation | none | **adds it** |
| Dropped content | none observed | **dropped a clause once**, silently |
| Latency | **~1.0 s** | ~2.6 s |
| Price | $0.36 / audio hour | **$0.27 / audio hour** |

Vocabulary is what decides accuracy, not the backend: without it, the same clip came back
as `hookcjs` from one and `Hugging CJS` from the other. With it, both produced `hook.cjs`.

Silent omission is the reason this is not a clear win. Garbled text is visible in the
composer and gets fixed; a missing clause is not. Try both on your own recordings —
these samples were synthesized speech, which articulates far more cleanly than anyone
actually dictating.

Inspect it any time:

```bash
curl 'http://127.0.0.1:30141/__voice/terms?session=<id>'
curl 'http://127.0.0.1:30141/__voice/terms?cwd=/path/to/project'
```

| Variable | Default | Meaning |
| --- | --- | --- |

**Thinking blocks, tool arguments and tool results are never read** — they are noisy and
they are where secrets live. Anything resembling a credential is dropped as well: known
key prefixes, hex digests, base64 blobs, and long separator-free mixed strings.

## Every setting

Nine variables, eight of which are credentials for three mutually exclusive backends.
That leaves one. Anything with one correct answer — route prefix, API versions, model
name, transcription style, timeouts, context window sizes, keyboard shortcut, and where
the key file lives — is a constant in `lib/config.cjs`, not a knob.

**Credentials** — set one group; the backend is chosen from whichever is present.

| Variable | For |
| --- | --- |
| `AZURE_SPEECH_ENDPOINT`, `AZURE_SPEECH_KEY` | Azure AI Speech (MAI-Transcribe-2) |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `PI_VOICE_DEPLOYMENT` | Azure OpenAI |
| `PI_VOICE_OPENAI_BASE_URL`, `OPENAI_API_KEY`, `PI_VOICE_OPENAI_MODEL` | OpenAI, Groq, local |

**Behaviour**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_PROVIDER` | inferred | `azure-speech`, `azure-openai`, `openai`, `mock`. Only needed to break a tie, force the mock, or A/B two backends |

The recognition language is never set, on purpose: automatic language identification and
mid-sentence code switching only work when it is left off.

## How it works

1. `hook.cjs` patches `http.Server.prototype.emit` in the pi-web process.
2. Requests under `/__voice/` are answered by the hook — `inject.js`, `transcribe`, and
   the `health` and `terms` diagnostics.
3. Every other request is forwarded untouched, except that `text/html` responses gain
   one `<script>` tag. JSON, static assets, file uploads, and the SSE event stream are
   passed through unbuffered and byte-for-byte.
4. `public/inject.js` mounts the button, records with `AudioContext`, encodes 16 kHz
   mono PCM WAV in the page, and writes the result into the composer through the
   `HTMLTextAreaElement` value setter so React sees the change.

`inject.js` is read from the active hook installation on every request, so editing that
copy takes effect on reload — no restart, and running agent sessions stay alive.

Backend files under `lib/` are loaded into the pi-web process. After installing a backend
change, restart pi-web; refreshing the page alone is not enough. Editing a checkout also
does not update a separate global npm installation: check the service's `NODE_OPTIONS`
path to confirm which copy it actually loads.

## Privacy

Audio goes from your browser to your own pi-web origin, and from there to the speech
backend you configured. The page is only told which provider is active, never the key.
Audio and transcripts are not written to disk. The service emits the metadata-only
[request logs](#transcription-logs) described above; no additional service is contacted.

`~/.pi/agent/voice.env` is parsed into a private object rather than merged into
`process.env`. pi-web runs the agent's shell commands as children of its own process, so
anything placed in that environment would be handed to every command the agent ever runs.
Keeping the credentials out of it means only the transcription request sees them.

## Compatibility

Verified against pi-web `0.9.0` (pi `0.85.1`). The only version-sensitive part is the
button anchor in `inject.js`, which looks for the image-attach button by title and falls
back to the toolbar's model selector. If a future pi-web moves things, that one function
is what needs adjusting — the hook itself only depends on Node's HTTP API.

The button is a plain `<button>` driven by `click`, so anything that can activate a
button can start a recording: a tap, a mouse, the keyboard, VoiceOver, the macOS
accessibility API, `Cmd/Ctrl+Shift+V`, or a squeeze on a pair of AirPods.

## Tests

```bash
npm test                                          # offline unit/HTTP/logging tests
npm run test:retry                                # isolated browser retry regression
npm run test:e2e -- http://127.0.0.1:31141          # real pi-web integration
```

All three commands clear `NODE_OPTIONS` in their child runner so a globally installed hook
cannot intercept the test runner or its local fixtures. Browser suites are opt-in; they require
Node 22+ and Microsoft Edge, or `BROWSER=/path/to/chromium` to select another Chromium binary.

`npm test` runs only `*.test.mjs` files. Provider requests are mocked: VAD encoding,
empty/nonempty responses, vocabulary-free requests and keyword
fallback are covered. Local HTTP route tests check request IDs, VAD/outcome logging,
error statuses and that private content stays out of logs, including two failed uploads
followed by a successful retry of the same audio. A minimal DOM/VM harness checks
that empty responses preserve the draft, caret and focus, while normal transcripts still
insert into the composer rather than the terminal. Retry tests cover network/HTTP/JSON failures,
retaining and resubmitting the same WAV, double clicks, persistent red error details with an
inline retry, notice timers, composer re-mounting and localization, conversation switches,
missing composers and safely replacing a pending recording. Audio lifecycle tests exercise
running, suspended, interrupted and closed contexts, failed/stalled/timed-out resumes, stream
cleanup, and rebuilding a context after zero samples. Click-only regressions exercise abandoned
presses, rapid start-cancel-start while opening/resuming, late success/failure cleanup, a peak of
one live stream per page, and activation-to-ready timing metadata. Diagnostic tests distinguish client,
network, HTTP, response-format and explicit empty-result cases, including optional request IDs.
No microphone, credentials, browser, or live speech-service calls are needed.

`npm run test:retry` starts a loopback HTTP fixture and an isolated headless browser with
an ephemeral debug port and temporary profile. It does not require pi-web, microphone access,
credentials, or a live speech service. The fixture holds each response until the test releases
it, making pending/disabled states deterministic. It checks:

- Click-only microphone ownership using generated Web Audio streams (never device input): long
  pointer holds open nothing, rapid cancellation never opens a second stream, late streams are
  released, and the next explicit click captures and uploads samples normally.
- English desktop and Chinese 320 px mobile layouts: original red error details, white
  underlined Retry text, no separate border/background and a 44 × 44 px minimum touch target.
- Persistent errors, repeated failures without stacked notices, long errors that wrap/scroll,
  and provider text rendered as text rather than executable HTML.
- Mouse and keyboard retries, duplicate-click suppression and survival of composer re-mounting.
- Byte-identical WAV uploads across attempts, insertion exactly once, no microphone reopened,
  and no writes to the terminal helper textarea.
- Cleanup after success and the documented loss of page-only audio after a refresh.
- Distinct client-no-audio and server-empty-text messages, including whether an upload occurred.

The final underlined Retry presentation was also manually accepted in the deployed service;
that check complements, rather than replaces, the automated regression tests.

`npm run test:e2e` drives headless Edge over the DevTools protocol against a real pi-web:
it waits for the button to mount, proves the terminal's hidden textarea is not mistaken for
the composer, feeds the recorder a synthetic audio stream, and checks the round trip.
Use a separate test instance with `PI_VOICE_PROVIDER=mock` to avoid live transcription calls;
otherwise this suite uses the target instance's configured provider.

The timing of the press is covered there too, because it is not something you can eyeball
reliably. With `getUserMedia` stubbed to take 1.2 seconds, it asserts that the button is
red in the same task as the click, that the clock starts when the audio graph is ready, that a
second press during the wait cancels without leaving the microphone open, that subsequent
rapid presses cannot start another opening, and that holding or abandoning a pointer gesture
never requests the microphone at all. It also holds a real mouse press across a
clock tick and verifies that one click still stops recording, and advances the recording
clock across the 10-minute boundary to verify automatic stopping. The icon and clock
nodes stay mounted while their properties and text are updated, so a timer tick cannot
replace the element between `mousedown` and `mouseup` and make Chromium suppress the
click. Set `BROWSER` to use a different Chromium binary.

## Change history

See [CHANGELOG.md](CHANGELOG.md) for unreleased changes and their verification scope.

## Uninstall

Drop the `NODE_OPTIONS` variable, or stop using `pi-web-voice` to launch. Nothing was
installed into pi-web, so there is nothing to revert.

## License

MIT
