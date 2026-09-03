# pi-web-voice

Voice input for [pi-web](https://github.com/agegr/pi-web), added from the outside.

A microphone button appears in the chat composer. Tap it to start and tap again to stop,
or press and hold to talk and release when done — the gesture decides, there is nothing
to configure. The transcript lands at your caret; you review it, then send. pi-web is never modified: the
whole thing is one `--require` hook that injects a single `<script>` tag into HTML
responses and serves two routes of its own.

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
PI_VOICE_MODE=hold
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
| `PI_VOICE_DEPLOYMENT` | `gpt-4o-transcribe` |

The request shape follows the deployment name:

- **`gpt-transcribe`** uses the v1 surface and gets the vocabulary as structured
  `keywords[]`, plus `languages[]` derived from the browser's `Accept-Language`. No token
  budget to fight, and nothing a model could mistake for an instruction.
- **`gpt-4o-transcribe`** and whisper use the classic deployment path with a `prompt`.
  Whisper reads only the last 224 tokens of it, so the list is trimmed to fit. Note that
  `gpt-4o-transcribe` version `2025-03-20` retires on 15 October 2026.

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
2. Requests under `/__voice/` are answered by the hook — `inject.js` and `transcribe`.
3. Every other request is forwarded untouched, except that `text/html` responses gain
   one `<script>` tag. JSON, static assets, file uploads, and the SSE event stream are
   passed through unbuffered and byte-for-byte.
4. `public/inject.js` mounts the button, records with `AudioContext`, encodes 16 kHz
   mono PCM WAV in the page, and writes the result into the composer through the
   `HTMLTextAreaElement` value setter so React sees the change.

`inject.js` is read from disk on every request, so editing it takes effect on reload —
no restart, and any agent session you have running stays alive.

## Privacy

Audio goes from your browser to your own pi-web origin, and from there to the speech
backend you configured. The page is only told which provider is active, never the key.
Nothing is written to disk and nothing else is contacted.

`~/.pi/agent/voice.env` is parsed into a private object rather than merged into
`process.env`. pi-web runs the agent's shell commands as children of its own process, so
anything placed in that environment would be handed to every command the agent ever runs.
Keeping the credentials out of it means only the transcription request sees them.

## Compatibility

Verified against pi-web `0.8.11` (pi `0.84.3`). The only version-sensitive part is the
button anchor in `inject.js`, which looks for the image-attach button by title and falls
back to the model selector, then to the send button's row. If a future pi-web moves
things, that one function is what needs adjusting — the hook itself only depends on
Node's HTTP API.

## Tests

```bash
npm test                                        # HTTP interception, no pi-web needed
node test/e2e-edge.mjs http://127.0.0.1:31141   # real pi-web + real browser
```

The end-to-end test drives headless Edge over the DevTools protocol: it waits for the
button to mount, feeds the recorder a synthetic audio stream (headless browsers have no
microphone), and asserts that the transcript reaches the composer. Set `BROWSER` to use
a different Chromium binary.

## Uninstall

Drop the `NODE_OPTIONS` variable, or stop using `pi-web-voice` to launch. Nothing was
installed into pi-web, so there is nothing to revert.

## License

MIT
