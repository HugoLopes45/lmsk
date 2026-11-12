# Troubleshooting

This page lists each message that lmsk can show, what it means and what to do.

The extension follows one rule: if it cannot mask something safely, it does not send it. So most problems stop a request. A stopped request sends nothing to the model provider.

## How to read a message

Most messages have one of these forms:

```text
lmsk: CODE. The request was stopped. Masking stays on.
lmsk: CODE. Requests that need masking are blocked.
```

The first form means that the extension stopped one request and the session continues. The second form means that the session is blocked. `CODE` is an error code, for example `SCAN_TIMEOUT`. Find the code in the tables below.

- pi shows each form only once in a session. A block always shows its message, also after a stopped request. To see the current state, type `/lmsk status`.
- The `HIDDEN_REAL` message for a request and the `SUMMARY_BLOCKED` message come back each time.
- The message shows only the code. It never shows the secret or the file contents.

## Two kinds of errors

| Kind | What happens | How it ends |
|---|---|---|
| The request is stopped | The extension cancels one request. The agent stops its current work. | Send the request again, or remove the cause. |
| The session is blocked | The extension blocks each request that needs masking. `/lmsk status` shows `lmsk: blocked (CODE)`. `/lmsk` cannot change masking. | Correct the cause, then type `/reload`. You can also start a new session with `/new` or open another one with `/resume`. |

## Other things that you can see

| What you see | Meaning | What to do |
|---|---|---|
| `SUMMARY_BLOCKED: summary could not be safely generated` | pi tried to make a summary of the conversation, for `/compact` or for `/tree`. The extension could not mask it safely, so pi made no summary. The causes include: no model is selected, a masking error, a secret glued to a word, or an empty summary. | Try again. If the summary is blocked again, start a new session with `/new`. Or type `/tree`, and when pi asks `Summarize branch?`, choose `No summary`. |
| The model says that it got `lmsk: withheld.` in place of a text | The text holds a secret in a hidden form, such as spaced out, reversed or encoded. The model provider got `lmsk: withheld. This text holds a secret spaced out, wrapped, reversed or encoded.` in its place. You still see the real text. | If the text was ordinary output, you can set `withholdHiddenCopies` to `false`. See [Settings](CONFIGURATION.md#settings). |
| `protected path` as the reason that a tool call was refused | The agent tried to `read`, `grep`, `find` or `ls` a protected file, such as `.env`. | This is the normal protection. To allow a path, remove its glob with `!` in the global configuration. See [Default protected paths](CONFIGURATION.md#default-protected-paths). |
| `lmsk: off. The provider gets real values.` | You typed `/lmsk off`. Masking is off. | Type `/lmsk on` to start masking again. The model provider keeps the real values that it got while masking was off. |
| `Usage: /lmsk status\|on\|off\|reveal [text]` | The `/lmsk` command got an unknown word. | Type `/lmsk status`, `/lmsk on`, `/lmsk off` or `/lmsk reveal`. |

## Codes that stop a request

| Code | Meaning | What to do |
|---|---|---|
| `HIDDEN_REAL` | A token with a known prefix, or a value of a `mask` or `block` rule, is glued to a word. An example is `x` before a GitHub token. The extension cannot replace it there. A glued secret in the conversation stops each later request. | Do not type `/lmsk off` to get past this message. It sends the secret to the model provider. The easiest way out: start a new session with `/new`. To keep the conversation: type `/tree` and pick the message just before the one that contains the secret. When pi asks `Summarize branch?`, choose `No summary`. If pi puts your old message back in the input box, delete the secret before you send it. If the secret is in a context file, such as `AGENTS.md`, remove it from the file, then type `/reload`. |
| `SCAN_TIMEOUT` | The search for secrets took longer than `scanTimeoutMs` (5 seconds by default). A very long conversation can cause it. | Send the request again. If it is blocked again, start a new session with `/new`. You can also increase `scanTimeoutMs` in the global configuration. |
| `SCAN_CRASH` | The worker that searches for secrets stopped. | Send the request again. If the error comes back, type `/reload`. |
| `SCAN_PATTERN` | A regex failed during the search. | Check the `pattern` of your `regex` rules. Then type `/reload`. |
| `BLOCKED` | A rule with the `block` strategy found a value. Other causes: a found value overlaps a fake, or a value in an encoded text cannot get a safe fake. | If you made a `block` rule, remove the value from the conversation, as for `HIDDEN_REAL`. Otherwise, start a new session with `/new`. |
| `PAYLOAD_SIZE` | The text that masking scans in a request is larger than 8 MiB. Images, PDFs, and the signatures and encrypted content of provider blocks do not count. | Start a new session with `/new`. Ask the agent for smaller outputs, for example part of a file. |
| `PAYLOAD_SHAPE` | The request is not plain JSON data. | Report the problem as an issue. Do not include secrets. |
| `VAULT_FULL` | The vault has 50000 values, or its values have 2000000 characters together. This is the maximum. | [Start a new vault](#start-a-new-vault). |
| `VAULT_COLLISION` | The extension found no unused fake for a value, or a line of the vault gives one fake to two values. | Send the request again. If the error comes back, [start a new vault](#start-a-new-vault). |

## Codes that block the session

The vault is the file `vault.jsonl` that keeps each real value next to its fake. Its folder is `~/.local/state/lmsk/`, or `lmsk/` in `XDG_STATE_HOME` if you set it. Each agent on your computer uses this vault. The `key` file in the same folder makes the fakes.

| Code | Meaning | What to do |
|---|---|---|
| `CONFIG_INVALID` | A configuration file has an error. See [CONFIG_INVALID](#config_invalid). | Correct the file, then type `/reload`. |
| `STORE_BUSY` | Another process holds the lock file `vault.lock` of the vault, and does not release it. | Close your other agents. If the error stays, delete the `vault.lock` file in the vault folder by hand. Then type `/reload`. |
| `STORE_UNSAFE` | The vault folder, `vault.jsonl` or `key` has wrong permissions or a wrong owner. The folder must have mode 700 and the two files mode 600, all owned by your user. | On macOS or Linux, run `chmod 700` on the folder and `chmod 600` on the two files. Then type `/reload`. |
| `STORE_CORRUPT` | A line of `vault.jsonl` is not valid, or the `key` file has a wrong length. | [Start a new vault](#start-a-new-vault). If the `key` file is bad, move it too. |
| `STORE_IO` | The computer could not read or write the vault file, for example because the disk is full. | Correct the disk problem, then type `/reload`. |
| `UNEXPECTED_ERROR` | Another error. A `fixed` rule without `{n}` in its `replacement` causes it. A failure to read your user name, host name or git identity causes it too. | Check your `fixed` rules. Then type `/reload`. If the error stays, report it as an issue. |
| `NOT_STARTED` | The session has not started yet. | Wait, or type `/reload`. |
| `SESSION_SHUTDOWN` | The session is closing. | Start or open a session. |

A failed read or save of the vault during a request stops only that request. But a line of `vault.jsonl` that is not valid stops each later request with `STORE_CORRUPT` or `VAULT_COLLISION`, until you [start a new vault](#start-a-new-vault).

### Start a new vault

1. Close each pi session.
2. If you use Claude Code, stop the proxy. On macOS, run `launchctl bootout gui/$(id -u)/io.github.hugolopes45.lmsk`. On Linux, run `systemctl --user stop lmsk.service`.
3. Move the file `vault.jsonl` out of the vault folder. Keep the `key` file, so that each value gets the same fake again.
4. If you use Claude Code, run `lmsk install claude`. It starts the proxy again.

If you move the `key` file too, each value gets a new fake.

## Claude Code

With Claude Code, the codes above have the same meaning, with these differences:

- Claude Code shows a stopped request as an API error with the text `lmsk: CODE`, for example `API Error: 400 lmsk: SCAN_TIMEOUT`.
- There is no `/lmsk` command and no `/reload`. To clear a block, correct the cause, then run `lmsk install claude`. It starts the proxy again.
- Where this page says `/tree`, type `/rewind`, then choose `Restore conversation`.
- The proxy writes its messages to `serve.log` in the vault folder on macOS. On Linux, run `journalctl --user -u lmsk.service`.

These messages occur only with Claude Code:

| What you see | Meaning | What to do |
|---|---|---|
| `lmsk: <path> is a protected path` as the reason that a tool call was refused | The hook refused a call that opens a protected path. | This is the normal protection. See [Default protected paths](CONFIGURATION.md#default-protected-paths). |
| `lmsk: hook failed: CODE.` | The hook failed, for example on an input that it cannot read. Claude Code then refuses the call. | Report the problem as an issue, with the code. |
| `lmsk: UPSTREAM` | The proxy could not reach Anthropic or your gateway. | Check your network connection, then send the request again. |
| `lmsk: FORBIDDEN` | A program sent a request to the proxy without its private token. | Run `lmsk install claude`, then restart Claude Code. Do not copy the proxy address into another program. |
| `Connection refused` (`ECONNREFUSED`) | The proxy does not run. | Run `lmsk install claude`. If the error comes back, read the messages of the proxy. |
| `lmsk: SETTINGS_INVALID: <detail>.` from `lmsk install claude` | Your user settings file is not JSON, or one of its keys that lmsk changes has a wrong type. | Correct the file, then run the command again. |
| `lmsk: SERVICE_FAILED: <command> exited <number>.` from `lmsk install claude` | `launchctl` or `systemctl` could not start the service. | Read the output of the command above the message. Correct the cause, then run the command again. |
| `lmsk: PLATFORM_UNSUPPORTED: lmsk runs on macOS and Linux.` | Your operating system is not macOS or Linux. | Use pi, or use Claude Code on macOS or Linux. |
| `TOKEN_CORRUPT` in the messages of the proxy | The file `serve-token` in the vault folder is not valid. | Delete the file, run `lmsk install claude`, then restart Claude Code. |

## CONFIG_INVALID

The message does not tell which part of the file is wrong. Check the file for these errors:

| Problem | Example |
|---|---|
| The file is not valid JSON. | A comma after the last item, or a missing quote. |
| The file does not contain a JSON object. | The file starts with `[` instead of `{`. |
| A setting has an unknown name. | `protectedPath` instead of `protectedPaths`. |
| A rule `id` is not valid. | An `id` that starts with `-` or contains a space. |
| A `regex` rule has a `pattern` that is not a valid regex. | `"pattern": "(abc"` |
| A `group` is not a capture group of the pattern. | `"group": 2` for a pattern with one group. |
| An `env` rule has no `vars` and no `namePattern`. | `{ "id": "x", "type": "env" }` |
| A `fixed` rule has no `replacement`. | `"strategy": "fixed"` alone. |
| `restoredTools` names a tool that is not a built-in tool. | `"restoredTools": ["mytool"]` |
| A project file changes a default or global rule. | `{ "id": "email", "enabled": false }` in `<project>/.pi/lmsk.json`. |
| A project file removes an item with `!`. | `"protectedPaths": ["!**/*.pem"]` in a project file. |
| A project file sets a global-only setting. | `restoredTools`, `withholdHiddenCopies` or `scanTimeoutMs` in a project file. |

The rules for each setting are in [CONFIGURATION.md](CONFIGURATION.md).
