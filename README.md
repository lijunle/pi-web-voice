# pi-web-voice

Voice input for [pi-web](https://github.com/agegr/pi-web), added from the outside.

A microphone button appears in the chat composer. Hold or click it, speak, and the
transcript lands at your caret — review it, then send. pi-web is never modified: the
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
git clone https://github.com/YOU/pi-web-voice.git ~/pi-web-voice

# 1. try it with the built-in mock backend — no credentials needed
NODE_OPTIONS="--require ~/pi-web-voice/hook.cjs" pi-web

# 2. once it works, point it at a real backend
export AZURE_SPEECH_ENDPOINT=my-speech-resource   # or a full https URL
export AZURE_SPEECH_KEY=...
export PI_VOICE_TERMS="MCP Probe, USWDS, repin, stateless"
NODE_OPTIONS="--require ~/pi-web-voice/hook.cjs" pi-web
```

Or install it and skip the environment variable:

```bash
npm install -g ./pi-web-voice
pi-web-voice          # starts pi-web with the hook, passes every argument through
pi-web-voice -p 8080
```

You should see this on startup, and a microphone next to the image-attach button:

```
[pi-web-voice] active · provider=azure-speech · prefix=/__voice
```

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
| `PI_VOICE_SPEECH_MODEL` | `MAI-Transcribe-2` | Also accepts `MAI-Transcribe-1.5` |
| `PI_VOICE_SPEECH_STYLE` | `clean` | `clean` drops fillers, `verbatim` keeps them |
| `PI_VOICE_SPEECH_API_VERSION` | `2025-10-15` | |

### `azure-openai` — gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper

| Variable | Default |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | — |
| `AZURE_OPENAI_API_KEY` | — |
| `PI_VOICE_DEPLOYMENT` | `gpt-4o-transcribe` |
| `PI_VOICE_OPENAI_API_VERSION` | `2024-10-21` |

`PI_VOICE_TERMS` becomes the `prompt` field. Whisper only reads the last 224 tokens of a
prompt, so the vocabulary is trimmed to fit rather than sent whole.

### `openai` — OpenAI, Groq, or a local server

| Variable | Default |
| --- | --- |
| `PI_VOICE_OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `PI_VOICE_OPENAI_API_KEY` | falls back to `OPENAI_API_KEY` |
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
4. With no session yet, the project's recent conversations are used instead. With
   neither, nothing is sent — no invented vocabulary.

Inspect it any time:

```bash
curl 'http://127.0.0.1:30141/__voice/terms?session=<id>'
curl 'http://127.0.0.1:30141/__voice/terms?cwd=/path/to/project'
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_CONTEXT` | `session` | `session`, `project` (adds recent sessions in the same directory), or `off` |
| `PI_VOICE_MAX_TERMS` | `400` | Upper bound, further capped by what the provider accepts |
| `PI_VOICE_CONTEXT_BYTES` | `262144` | How much of each session file to read, from the end |
| `PI_VOICE_PROJECT_SESSIONS` | `5` | How many past sessions to include under `project` |
| `PI_VOICE_TERMS` | — | Pinned extras, always sent first |

**Thinking blocks, tool arguments and tool results are never read** — they are noisy and
they are where secrets live. Anything resembling a credential is dropped as well: known
key prefixes, hex digests, base64 blobs, and long separator-free mixed strings.

## Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_LOCALE` | — | Force a language (`zh`, `en`). **Leave empty for mixed-language speech** |
| `PI_VOICE_MODE` | `toggle` | `toggle` = click to start and stop, `hold` = press and hold |
| `PI_VOICE_AUTO_SEND` | `0` | `1` submits immediately instead of waiting for review |
| `PI_VOICE_SHORTCUT` | `mod+shift+v` | Keyboard toggle |
| `PI_VOICE_MEDIA_SESSION` | `1` | Headphone play/pause starts and stops recording |
| `PI_VOICE_MAX_SECONDS` | `180` | Recording auto-stops here |
| `PI_VOICE_PREFIX` | `/__voice` | Change if it collides with something |
| `PI_VOICE_ENABLED` | `1` | `0` disables the hook without unsetting `NODE_OPTIONS` |

Everything above can also live in `~/.pi/agent/voice.json` (environment wins):

```json
{
  "provider": "azure-speech",
  "terms": ["MCP Probe", "USWDS", "repin"],
  "azureSpeech": { "endpoint": "my-resource", "key": "..." },
  "ui": { "mode": "hold", "autoSend": false }
}
```

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

Audio goes from your browser to your own pi-web origin, and from there to the
speech backend you configured. Credentials stay on the server; the page is only told
which provider is active. Nothing is written to disk and nothing else is contacted.

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
