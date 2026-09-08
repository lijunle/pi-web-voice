# pi-web-voice

Voice input for [pi-web](https://github.com/agegr/pi-web), without modifying pi-web itself.

Click the microphone, wait for the clock, and speak. Your transcript appears at the
caret in the chat composer: review it, edit it, then send.

## Why pi-web-voice

- **No fork, no rebuild.** A Node.js hook adds voice input to your existing pi-web
  installation. There are no third-party runtime dependencies or build steps.
- **Vocabulary from your conversation.** Project names and technical terms are mined
  from the active conversation and its project's recent sessions to help transcription.
- **Your choice of backend.** Use Azure OpenAI with `gpt-transcribe`, Azure AI Speech,
  or an OpenAI-compatible service such as OpenAI, Groq, or a local whisper server.
- **Retry without repeating yourself.** Keep a failed take in page memory and resubmit
  it manually, without reopening the microphone.
- **You stay in control.** Text is inserted, never automatically sent. The microphone
  button also works with the keyboard and VoiceOver.

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

The file is created with mode `0600`. Keep credentials there, outside your repository.
Prefer another service? See [backend configuration](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#backends).

### 3. Check and start

```bash
pi-web-voice doctor    # sends a generated tone to check the configured backend
pi-web-voice           # launches pi-web with voice input
```

Open the URL printed by pi-web, click the microphone beside the image-attach button,
allow microphone access, and **wait for the clock before speaking**. Stay in the same
conversation while recording. Click again to stop; the returned text goes into the composer.

**Keyboard shortcut:** with the pi-web page focused, press **Cmd+Shift+V** on macOS or
**Ctrl+Shift+V** on Windows/Linux to start or stop recording without clicking the microphone.

Arguments pass through to pi-web, so `pi-web-voice -p 8080` selects another port.
To check only the button and recording round trip without a speech account, set
`PI_VOICE_PROVIDER=mock` in `voice.env`, then launch `pi-web-voice`. Mock returns
diagnostic text, not a real transcript.

## Before you use it

- **Use HTTPS or localhost.** Browsers do not allow microphone capture on ordinary
  plain-HTTP LAN addresses. See [remote access and deployment](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#deployment-and-remote-access).
- **Audio and vocabulary go to your configured transcription service.** The hook does
  not put API keys in the page configuration. See [privacy and access control](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#privacy-and-access-control).
- **A pending take is temporary.** Refreshing, closing, or discarding the page loses it.
  Retry before reloading; another upload may incur another provider charge.

## Documentation

| I want to… | Read |
| --- | --- |
| Configure a backend, record, or deploy as a service | [Usage guide](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md) |
| Understand an error or find its request log | [Troubleshooting](https://github.com/lijunle/pi-web-voice/blob/main/USAGE.md#diagnostics-and-troubleshooting) |
| Modify the code or run tests | [Development guide](https://github.com/lijunle/pi-web-voice/blob/main/DEVELOPMENT.md) |
| Understand implementation choices and transcription experiments | [Design decisions and validation](https://github.com/lijunle/pi-web-voice/blob/main/DEVELOPMENT.md#design-decisions-and-validation) |
| See what changed before upgrading | [Changelog](https://github.com/lijunle/pi-web-voice/blob/main/CHANGELOG.md) |

## License

[MIT](https://github.com/lijunle/pi-web-voice/blob/main/LICENSE).
