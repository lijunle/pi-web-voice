# Test fixtures

## Synthetic speech

`voice-en.wav` contains this generated sentence:

> This is a voice input test. The quick brown fox jumps over the lazy dog.

The fixture uses macOS speech synthesis with the Samantha voice at 150 words per
minute, converted to 16 kHz mono 16-bit PCM. It contains no microphone recording,
personal conversation, or credentials. E2E plays the committed file through a Web
Audio stream, so running the tests requires neither speech-synthesis tools nor a
physical microphone.

To regenerate it on macOS with FFmpeg installed:

```bash
say -v Samantha -r 150 -o /tmp/voice.aiff \
  'This is a voice input test. The quick brown fox jumps over the lazy dog.'
ffmpeg -y -i /tmp/voice.aiff -ac 1 -ar 16000 -c:a pcm_s16le \
  -map_metadata -1 -fflags +bitexact test/fixtures/voice-en.wav
```

The live E2E contract requires nonempty text containing `voice input test` and
`quick brown fox`, ignoring case and punctuation, plus exact insertion of the
returned text into the draft. This small recognition smoke check complements
provider-specific accuracy evaluation; it is not a quality benchmark.

## Suite lifecycle

`suite-host.mjs` belongs to the server integration harness. Its caller supplies a
loopback pi-web stub on a temporary PATH and an outer supervisor-owned directory.
The fixture uses placeholder credentials and deliberately exercises callback failure,
early exit, and an event-loop freeze. Run it through `npm run test:integration` so the
supervisor owns forced process cleanup. These cases use no speech service or agent key.
