# Changelog

## Unreleased

- The protected-path checks of lmsk ignore case, so `~/.AWS/credentials` or `.NPMRC` on a macOS or Windows disk is protected too. On Linux, a path that differs only in case from a protected path is now also protected.
- Claude Code: if lmsk ends on an error, it now ends `claude` too. Before, `claude` kept sending to the closed port, which another local user could take.
- Claude Code: the deny hook runs the lmsk of the same package, not the first `lmsk` on your `PATH`.
- Claude Code: a project `NO_PROXY` can no longer send requests to an HTTP proxy before they reach lmsk.
- Claude Code: the proxy refuses an upstream redirect, which would send your API key to another address.
- Text inside an object under a `signature` or `encrypted_content` key, such as a tool schema field, is now masked. A string under such a key still passes unchanged.
- The pi peer dependencies require version 1.
- A request that puts real values back into tool arguments now scans again only the texts that hold one of them, not the whole conversation.
- A long text without line breaks, such as minified code, scans up to five times faster.
- The limits now say that base64 documents, the request path, and the pi `/bug` summary are not masked, and which encoded copies of a value are masked.

## 0.2.1

- The README shows how lmsk fits everyday work: debugging from logs, writing configuration files, running local tests and masking client names. Its FAQ explains how lmsk works with gitleaks.

## 0.2.0

- lmsk is now one npm package, `@hugolopes45/lmsk`, for Claude Code and pi. The other `@hugolopes45/lmsk-*` packages get no more releases. If you use pi, run `pi remove npm:@hugolopes45/lmsk-pi`, then `pi install npm:@hugolopes45/lmsk`.

## 0.1.2

- The release workflow failed before it published 0.1.1, so npm has no 0.1.1. This release publishes the changes of 0.1.1.

## 0.1.1

- Keyed secrets: an unquoted value that holds `.`, `:`, `&`, `(`, `<`, `,` or `@` is masked in full. Before, it was cut at the first such character, or not masked at all.
- Keyed secrets: such a value is also masked when more text follows it on its line, as in `DB_PASSWORD=<value> psql ...`, `export PW=<value>; echo ok` or inline code. Before, only a value at the end of its line was masked.
- Every package declares Node.js 22.19 or later in `engines`. pi already needs it.

## 0.1.0

First release.

- `@hugolopes45/lmsk-pi`: a pi extension that masks each provider request, saved message, tool result and summary, and puts the real values back into the built-in tools. See [lmsk with pi](docs/pi.md).
- `lmsk claude` (preview): starts Claude Code behind a local proxy that masks each request and puts the real values back into the tool calls. A deny hook refuses tool calls on protected paths. See [lmsk with Claude Code](docs/claude-code.md).
- Default rules: more than 200 vendor key formats from gitleaks, keyed secrets, credentials in URLs and headers, emails, phone numbers, IBANs, payment cards, ids, secret variable names and your local identity.
- Rule types `literal`, `env`, `regex` and `keyed`, and the settings `protectedPaths`, `networkCommands`, `restoredTools`, `withholdHiddenCopies` and `scanTimeoutMs`. See [Configuration](docs/CONFIGURATION.md).
- Fail closed: a request that cannot be masked safely is cancelled.
