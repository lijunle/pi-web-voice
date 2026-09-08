# pi-web-voice

Voice input for pi-web through a Node.js hook.

## Read first

- [README.md](README.md): overview and quick start.
- [USAGE.md](USAGE.md): configuration, usage, deployment, and troubleshooting.
- [DEVELOPMENT.md](DEVELOPMENT.md): architecture, testing, and design decisions.
- [CHANGELOG.md](CHANGELOG.md): release history in Keep a Changelog format.

## Principles

- Keep the runtime dependency-free and build-free. Integrate through the hook and
  preserve pi-web's installed files.
- Keep credentials and personal machine-specific values in documented configuration
  mechanisms, outside tracked files.
- Preserve the documented privacy boundaries. Insert transcripts into the composer
  for the user to review and send.
- Run relevant checks (`npm test` by default) with mocked or isolated services. Report
  the checks actually run; use live speech services only when requested.
- Link to existing guides for detailed instructions and record user-visible behavior
  changes under `[Unreleased]` in CHANGELOG.md.
- **Describe the present.** Use present tense for explanatory prose, including design
  decisions and validation results. Put before/after change narratives in CHANGELOG.md.
- **State the action.** Prefer positive, actionable instructions such as "Use..." and
  "Keep...". Express constraints through the required behavior wherever practical.

CHANGELOG.md is the only document exempt from the last two writing rules.
