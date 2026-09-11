# pi-web-voice

[![CI](https://github.com/lijunle/pi-web-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/lijunle/pi-web-voice/actions/workflows/ci.yml)
[![E2E](https://github.com/lijunle/pi-web-voice/actions/workflows/e2e.yml/badge.svg?branch=main&event=workflow_dispatch)](https://github.com/lijunle/pi-web-voice/actions/workflows/e2e.yml)

Voice input for [pi-web](https://github.com/agegr/pi-web) through a standalone Node.js hook.

Click the microphone, wait for the clock, and speak. Your transcript appears at the
caret in the chat composer: review it, edit it, then send.

![pi-web chat composer with an active microphone and a 0:03 recording timer](https://raw.githubusercontent.com/lijunle/pi-web-voice/main/assets/recording.jpg)

## Why pi-web-voice

- **Drop-in integration.** Add a hook with zero runtime dependencies to your existing
  pi-web installation and run it directly from source, keeping pi-web's installed files intact.
- **Vocabulary from your conversation.** The hook extracts project names and technical
  terms from the active conversation and its project's recent sessions to help transcription.
- **Your choice of backend.** Use Azure OpenAI with `gpt-transcribe`, Azure AI Speech,
  or an OpenAI-compatible service such as OpenAI, Groq, or a local whisper server.
- **Retry the same recording.** Resubmit a failed take from page memory while the
  microphone stays closed.
- **Check quiet takes before transcription.** The hook checks for very low audio levels
  before calling a speech service. Use **Transcribe anyway** to recover a quiet take.
- **Review before sending.** Transcripts go into the composer for you to edit and send.
  The microphone button also works with the keyboard and VoiceOver.

## Quick start

You need **Node.js 20+**, a working [pi-web](https://github.com/agegr/pi-web)
installation (`npm install -g @agegr/pi-web` if needed), and a browser with microphone access.

### 1. Install and initialize

```bash
npm install -g pi-web-voice
pi-web-voice init
```

### 2. Configure Azure OpenAI

Edit `~/.pi/agent/voice.env` to use
[Azure OpenAI](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#azure-openai)
with `gpt-transcribe`. Replace the example endpoint with your deployment's complete
transcriptions URL from the Azure portal, and supply its key:

```sh
PI_VOICE_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-03-01-preview
AZURE_OPENAI_API_KEY=your-resource-key
PI_VOICE_DEPLOYMENT=gpt-transcribe
```

`init` creates the file with mode `0600`. Keep credentials there, outside your repository.
Prefer another service? See [backend configuration](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#backends).

### 3. Check and start

```bash
pi-web-voice doctor    # sends a generated tone to check the configured backend
pi-web-voice           # launches pi-web with voice input
```

Open the URL printed by pi-web, click the microphone beside the image-attach button,
allow microphone access, and **wait for the clock before speaking**. Stay in the same
conversation while recording. Click again to stop; the transcript goes into the composer.

**Keyboard shortcut:** with the pi-web page focused, press **Cmd+Shift+V** on macOS or
**Ctrl+Shift+V** on Windows/Linux to start or stop recording from the keyboard.

Arguments pass through to pi-web, so `pi-web-voice -p 8080` selects another port.
For a local check of the button and recording round trip, set `PI_VOICE_PROVIDER=mock`
in `voice.env`, then launch `pi-web-voice`. Mock generates diagnostic text; select a
speech backend when you want speech recognition.

## Before you use it

- **Use HTTPS or localhost.** These browser-trusted origins enable microphone capture.
  See [remote access and deployment](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#deployment-and-remote-access) for LAN and remote setup.
- **Forwarded audio and vocabulary go to your configured transcription service.**
  The silence check runs at your pi-web server; credentials stay in server-side configuration.
  See [privacy and access control](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#privacy-and-access-control).
- **Retry before reloading.** A pending take lives in page memory; refreshing, closing,
  or discarding the page clears it. Each additional upload may incur another provider charge.

## Documentation

| I want to… | Read |
| --- | --- |
| Configure a backend, record, or deploy as a service | [Usage guide](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md) |
| Understand an error or find its request log | [Troubleshooting](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#diagnostics-and-troubleshooting) |
| Modify the code or run tests | [Development guide](https://github.com/lijunle/pi-web-voice/blob/main/DEVELOPMENT.md) |
| Configure GitHub Actions or publish a release | [CI/CD setup](https://github.com/lijunle/pi-web-voice/blob/main/DEVELOPMENT.md#github-actions) |
| Understand implementation choices and transcription experiments | [Design decisions and validation](https://github.com/lijunle/pi-web-voice/blob/main/DEVELOPMENT.md#design-decisions-and-validation) |
| Review release changes before upgrading | [Changelog](https://github.com/lijunle/pi-web-voice/blob/main/CHANGELOG.md) |

## License

[MIT](https://github.com/lijunle/pi-web-voice/blob/main/LICENSE).
