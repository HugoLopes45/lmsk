# Changelog

## Unreleased

- Breaking: the Claude Code settings files `.claude/settings*.json`, the service file of the proxy and the code of lmsk are protected paths. With Claude Code, an agent can no longer read or change them. With pi, it can no longer read them. Edit your settings yourself.
- The files `key`, `vault.jsonl`, `vault.lock`, `serve-token` and `upstream` in any folder named `lmsk` are protected paths, also by a relative path.
- Claude Code: `lmsk install claude` adds an `Edit` deny rule next to each `Read` rule. Run it again to add them.
- Claude Code: the deny hook reads a path that starts with `$HOME/` or `${HOME}/` from your home folder, as it reads `~/`.
- Claude Code: the deny hook also checks `NotebookEdit` and `MultiEdit`, and these tools get real values back. Run `lmsk install claude` again to update the hook.
- Protected paths also match an accented letter written as a base letter and a separate accent.
- The deny hook checks the words of a long shell command about 4 times faster.
- Breaking, for code that imports lmsk: `isProtectedPath(path, cwd, patterns)` is now `protectedPath(paths, cwd, patterns)`, which returns the first protected path.
- Protected paths also match when a letter is written in another form that the disk reads as the same letter, such as the long s `ſ` for `s`.

## 0.3.0

- Breaking: `lmsk claude` is gone. Run `lmsk install claude` once. It starts the proxy as a service at login and points your Claude Code user settings at it. Then start `claude` as usual: each session goes through the proxy. Run it again after you update lmsk or Node.js, change the configuration file, or start to use a gateway. There is no uninstall command: see [Uninstall](docs/claude-code.md#uninstall).
- Breaking: Claude Code: `lmsk install claude` runs only on macOS and Linux. On another system, it stops with `PLATFORM_UNSUPPORTED`.
- Breaking: replies show real values. The proxy puts the real values back into each streamed reply, and the pi extension into each reply. Thinking text keeps its fakes. A value under 8 characters also keeps its fake, unless it is a value of a `literal` or `env` rule. A value that the model glues to a letter, a digit or `_` keeps its fake too.
- Breaking: the pi session file holds real values. The extension puts the real values back into the summaries of `/compact` and `/tree` as it does into replies. Thinking text, and some short or glued values in replies and summaries, keep their fakes.
- Breaking: one vault for each computer, `~/.local/state/lmsk/vault.jsonl`, for pi and Claude Code. A value gets the same fake in each session on the computer. `/new` no longer starts a new vault, for example after `VAULT_FULL`: see [Start a new vault](docs/TROUBLESHOOTING.md#start-a-new-vault). lmsk no longer reads the vaults in `~/.pi/agent/lmsk-vaults/` and `~/.local/state/lmsk/vaults/`, or the tool calls in `~/.local/state/lmsk/sessions/`. So the session files that older versions saved keep their fakes.
- Breaking: Claude Code: a project settings file can now send the requests past the proxy, with `ANTHROPIC_BASE_URL` or a provider switch such as `CLAUDE_CODE_USE_BEDROCK`. A `--settings` file can do this too. `disableAllHooks: true` in a settings file, also in your user settings, now turns off the deny hook. `lmsk claude` refused your `--settings`, and its own `--settings` won over the project and user settings files.
- Breaking: a number in a tool argument keeps its fake. Before, lmsk put the real number back, and the next request sent it to the model provider unmasked, because lmsk masks only text.
- Claude Code: `lmsk install claude` sets `CLAUDE_CODE_MAX_RETRIES` to 3 if your user settings do not set it, and the provider switches, such as `CLAUDE_CODE_USE_BEDROCK`, to an empty value.
- Claude Code: the proxy uses the fixed port 25675. Do not use lmsk for Claude Code on a computer that other people log in to.
- Claude Code: resumed and forked sessions work. `FORKED_SESSION` and `CALLS_INVALID` are gone.
- Claude Code: an `env` rule reads only the environment of the service, not the variables of your terminal.
- Claude Code: the proxy no longer withholds the result of a tool call on a protected path. The hook refuses the call. A call whose path becomes a protected path after restore keeps its fakes.
- A known secret glued to a word, such as `build_<secret>`, is masked as its own value in each request. A glued token with a known prefix, or a glued value of a `mask` or `block` rule, still stops the request.
- A text that hides a secret spaced out, wrapped, reversed or encoded is withheld only in the request. You still see the real text.
- pi: a provider error is saved as pi gets it, not as a fixed text such as `503 provider error, text withheld`.
- pi: lmsk now masks the model calls that other extensions make with `ctx.modelRegistry.stream`, `streamSimple` or `complete`. If masking fails, the call ends with an error and sends nothing.
- pi: a `/compact` or `/tree` summary that an earlier session started no longer reaches the model provider unmasked after `/lmsk off`. lmsk cancels it.
- The codes `SIGNED_CHANGE`, `STORE_CONFLICT`, `STORE_MISSING`, `STORE_EXISTS`, `STORE_INVALID_ID`, `STORE_INVALID`, `STORE_EXHAUSTED`, `STORE_REFERENCE_INVALID`, `STORE_REFERENCE_AMBIGUOUS`, `STORE_REFERENCE_CONFLICT` and `VAULT_LEGACY` are gone.
- The package exports its engine with TypeScript types, so you can add lmsk to your own agent: `import { Guard } from "@hugolopes45/lmsk"`. The README shows an example. Imports of files inside `dist` no longer work.
- A tool result is now withheld when it holds a known secret written with JSON escapes (`\/`, `\"`) or HTML entities (`&amp;`, `&#47;`). A secret in `\u` escapes already was.
- A `bash` command keeps its fakes when quotes or backslashes hide a network command in it, such as `"curl"`, `$'curl'`, `c\url` or `bash -c 'curl ...'`. It also keeps them when options separate the words of the command, such as `git -C repo push`. It also keeps them when the command sets a variable to the whole name, or a brace list holds it, such as `X=curl; $X` or `{curl,...}`.
- Claude Code: the deny hook reads a `Bash` command also without its quotes and backslashes, so `cat .e''nv` and `cat .e$'n'v` are refused like `cat .env`.
- More commands keep their fakes by default: `gh`, `glab`, `npm publish`, `pnpm publish`, `yarn publish`, `docker push`, `docker login`, `podman push`, `podman login`, `socat`, `openssl s_client`, `aws`, `gcloud`, `az`, `kubectl`, `helm`, `xh`, `eval`, `dev/tcp` and `dev/udp`, and inline code for `python`, `python3`, `node`, `deno`, `bun`, `perl`, `ruby` and `php`. To remove one, add a `!` item to your global configuration, for example `"!aws"`.
- A password in a connection URL is no longer masked when it is an upper-case variable, a placeholder, or 8 to 15 letters and `_`. Examples are `${DB_PASSWORD}`, `<password>`, `****` and `postgres`. So a real password of 8 to 15 letters in a URL now reaches the model provider. Add a `literal` rule for it.
- A word from a known secret is no longer masked alone, such as `tangerine` from `tangerine-elephant-staple`, or the domain of an email. Masking it also changed each text that had the word by chance. The word is still masked in a request that holds the tool call that received the secret.
- A `Bearer` token of 8 to 15 characters after an `Authorization` key is now masked. Before, a `Bearer` token needed 16 characters. Such a token stays visible when it has only letters, `-` and `_`, such as `Bearer undefined`, `Bearer REDACTED` or `Bearer your-token-here`.
- A base64 document or data URL passes unchanged only when it is an image or a PDF. Other base64 documents and data URLs get the checks of other text. A `signature` or `encrypted_content` string passes unchanged only in a provider block: thinking, reasoning, signed text, web search result, compaction, advisor result, an OpenRouter `reasoning.text` detail, or a Bedrock `reasoningText`. Before, a tool argument with such a key reached the model provider unmasked.
- A tool argument field that a request passes unchanged keeps its fakes, such as `encrypted_content` in an object of type `reasoning`. Before, lmsk put the real value back in it, and the next request sent that value to the model provider unmasked.
- The protected-path checks of lmsk ignore case, so `~/.AWS/credentials` or `.NPMRC` on a macOS or Windows disk is protected too. On Linux, a path that differs only in case from a protected path is now also protected.
- Claude Code: the deny hook runs the lmsk of the same package, not the first `lmsk` on your `PATH`.
- Claude Code: the proxy refuses an upstream redirect, which would send your API key to another address.
- Text inside an object under a `signature` or `encrypted_content` key, such as a tool schema field, is now masked.
- The pi peer dependencies `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` require `^1.0.3`.
- A request that puts real values back into tool arguments now scans again only the texts that hold one of them, not the whole conversation.
- lmsk adds less time to each request. A side request, or a request of another session, no longer makes lmsk scan the whole conversation again. In a recorded Claude Code session, the 95th percentile of the added time went from 117 ms to between 19 and 26 ms.
- A text that holds a known secret in another case, such as `abcd1234ef` for `ABCD1234EF`, is now masked. The secret must have a digit and 8 or more characters. Before, if lmsk scanned the text before the secret became known, it withheld the text, or sent it unchanged with `withholdHiddenCopies: false`.
- A long text without line breaks, such as minified code, scans up to five times faster.
- The limits now say which values are not masked: image and PDF base64 documents, the request path, and the pi `/bug` summary. They also say which encoded copies of a value are masked.
- A request header is now withheld when it hides a secret spaced out, wrapped, reversed or encoded. So is a text that pi sends to a classifier or an image model. Before, they reached the model provider.
- Claude Code: a streamed reply whose content type is not in lowercase, such as `Text/Event-Stream`, now gets its real values back.
- A request no longer fails with `VAULT_COLLISION` when an encoded secret comes after a longer encoded run that holds it. An example is base64 with `=` padding.
- With a big vault, a request costs less. With 8000 values, lmsk took about 2.2 seconds to mask a request of a recorded Claude Code session, and now takes about 0.35 seconds. After lmsk learns a new value, it took about 3.9 seconds, and now takes about 0.2 seconds.
- The vault is full when its values have 2000000 characters together. A new value then stops the request with `VAULT_FULL`. Before, a vault with more than about 6 MB of values made V8 stop pi or the proxy.
- The vault file `vault.jsonl` has a maximum size of 32 MiB. A save that would make it larger stops with `VAULT_FULL`.

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
