# Changelog

## Unreleased

## 0.1.0

First release.

- `@lmsk/pi`: a pi extension that masks each provider request, saved message, tool result and summary, and puts the real values back into the built-in tools. See [lmsk with pi](docs/pi.md).
- `lmsk claude` (preview): starts Claude Code behind a local proxy that masks each request and puts the real values back into the tool calls. A deny hook refuses tool calls on protected paths. See [lmsk with Claude Code](docs/claude-code.md).
- Default rules: more than 200 vendor key formats from gitleaks, keyed secrets, credentials in URLs and headers, emails, phone numbers, IBANs, payment cards, ids, secret variable names and your local identity.
- Rule types `literal`, `env`, `regex` and `keyed`, and the settings `protectedPaths`, `networkCommands`, `restoredTools`, `withholdHiddenCopies` and `scanTimeoutMs`. See [Configuration](docs/CONFIGURATION.md).
- Fail closed: a request that cannot be masked safely is cancelled.
