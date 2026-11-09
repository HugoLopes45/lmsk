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
| The request is stopped | The extension cancels one request or withholds one tool result. The agent stops its current work. | Send the request again, or remove the cause. |
| The session is blocked | The extension blocks each request that needs masking. `/lmsk status` shows `lmsk: blocked (CODE)`. `/lmsk` cannot change masking. | Correct the cause, then type `/reload`. You can also start a new session with `/new` or open another one with `/resume`. |

While the session is blocked, the extension saves each new message and tool result as `[MASKED]`.

## Other things that you can see

| What you see | Meaning | What to do |
|---|---|---|
| `SUMMARY_BLOCKED: summary could not be safely generated` | pi tried to make a summary of the conversation, for `/compact` or for `/tree`. The extension could not mask it safely, so pi made no summary. The causes include: no model is selected, a masking error, a secret glued to a word, or an empty summary. | Try again. If the summary is blocked again, start a new session with `/new`. Or type `/tree`, and when pi asks `Summarize branch?`, choose `No summary`. |
| `[MASKED]` in place of a tool result or a message | The extension withheld the text, because it could not mask it safely. For a tool result, it can also hold a secret in a hidden form, such as reversed or encoded. | Read the error code that pi showed. If the tool output was ordinary text, you can set `withholdHiddenCopies` to `false`. See [Settings](CONFIGURATION.md#settings). |
| `protected path` as the reason that a tool call was refused | The agent tried to `read`, `grep`, `find` or `ls` a protected file, such as `.env`. | This is the normal protection. To allow a path, remove its glob with `!` in the global configuration. See [Default protected paths](CONFIGURATION.md#default-protected-paths). |
| `400 provider error, text withheld`, or the same text with `503` or `context_length_exceeded` | The model provider returned an error. Masking would change how pi reacts to it, so the extension saves this fixed text. The number and the words keep the reaction of pi: `503` means that pi can try again, and `context_length_exceeded` means that the conversation is too long. The rest of the error text is not saved. | Try again. If the conversation is too long, type `/compact` or start a new session with `/new`. |
| `lmsk: off. Raw data may reach the provider and disk.` | You typed `/lmsk off`. Masking is off. | Type `/lmsk on` to start masking again. Messages saved while masking was off stay unmasked. |
| `Usage: /lmsk status\|on\|off` | The `/lmsk` command got an unknown word. | Type `/lmsk status`, `/lmsk on` or `/lmsk off`. |

## Codes that stop a request

| Code | Meaning | What to do |
|---|---|---|
| `HIDDEN_REAL` | A secret is glued to a word, for example `build_<secret>`, or is in a hidden form in a tool result. The extension cannot replace it there. A glued secret in the conversation stops each later request. | Do not type `/lmsk off` to get past this message. It sends the secret to the model provider. The easiest way out: start a new session with `/new`. To keep the conversation: type `/tree` and pick the message just before the one that contains the secret. When pi asks `Summarize branch?`, choose `No summary`. If pi puts your old message back in the input box, delete the secret before you send it. If the secret is in a context file, such as `AGENTS.md`, remove it from the file, then type `/reload`. |
| `SCAN_TIMEOUT` | The search for secrets took longer than `scanTimeoutMs` (5 seconds by default). A very long conversation can cause it. | Send the request again. If it is blocked again, start a new session with `/new`. You can also increase `scanTimeoutMs` in the global configuration. |
| `SCAN_CRASH` | The worker that searches for secrets stopped. | Send the request again. If the error comes back, type `/reload`. |
| `SCAN_PATTERN` | A regex failed during the search. | Check the `pattern` of your `regex` rules. Then type `/reload`. |
| `BLOCKED` | A rule with the `block` strategy found a value. Other causes: a found value overlaps a fake, or a value in an encoded text cannot get a safe fake. | If you made a `block` rule, remove the value from the conversation, as for `HIDDEN_REAL`. Otherwise, start a new session with `/new`. |
| `PAYLOAD_SIZE` | The text that masking scans in a request, or the `details` of a tool result or custom message, is larger than 8 MiB. Images, signatures and encrypted content do not count. | Start a new session with `/new`. Ask the agent for smaller outputs, for example part of a file. |
| `PAYLOAD_SHAPE` | The request is not plain JSON data. | Report the problem as an issue. Do not include secrets. |
| `SIGNED_CHANGE` | A message has a provider signature, and masking would change the signed text. The extension withholds the message. | Start a new session with `/new`. |
| `VAULT_FULL` | The vault has 50000 values, the maximum. | Start a new session with `/new`. |
| `VAULT_COLLISION` | The extension found no unused fake for a value, or a saved vault entry is not valid. | Start a new session with `/new`. If the error comes back, report it as an issue. |

## Codes that block the session

The vault is a file that keeps each real value next to its fake. By default, its folder is `~/.pi/agent/lmsk-vaults/`. If you set the `PI_CODING_AGENT_DIR` environment variable, the folder is `lmsk-vaults` in that folder. Each session uses one vault file.

| Code | Meaning | What to do |
|---|---|---|
| `CONFIG_INVALID` | A configuration file has an error. See [CONFIG_INVALID](#config_invalid). | Correct the file, then type `/reload`. |
| `STORE_BUSY` | A lock file blocks the vault. A pi process that stopped during a save can leave it. | Close the other pi windows. If the error stays, delete the `.lock` file in the vault folder by hand. Then type `/reload`. |
| `STORE_CONFLICT` | The vault file changed after this session loaded it. Another pi process can cause it. | Close the other pi windows that use the same session. Then type `/reload`. |
| `STORE_UNSAFE` | The vault folder or file has wrong permissions or a wrong owner. The folder must have mode 700 and the file mode 600, both owned by your user. | On macOS or Linux, run `chmod 700` on the folder and `chmod 600` on the file. Then type `/reload`. |
| `STORE_MISSING` | The session refers to a vault file that does not exist. | Start a new session with `/new`. Old fakes in this session cannot get their real values back. |
| `STORE_CORRUPT` | The vault file is not valid JSON, or has a wrong structure. | Start a new session with `/new`. |
| `STORE_IO` | The computer could not read or write the vault file, for example because the disk is full. | Correct the disk problem, then type `/reload`. |
| `STORE_EXISTS`, `STORE_INVALID_ID`, `STORE_INVALID`, `STORE_EXHAUSTED` | An internal vault error. | Start a new session with `/new`. Report the problem as an issue. |
| `STORE_REFERENCE_INVALID`, `STORE_REFERENCE_AMBIGUOUS`, `STORE_REFERENCE_CONFLICT` | The session file refers to a vault in a way that is not valid, or this part of the session refers to another vault. | Start a new session with `/new`. |
| `VAULT_LEGACY` | The session was made by an older version of the extension. This version does not convert it. | Start a new session with `/new`. |
| `UNEXPECTED_ERROR` | Another error. A `fixed` rule without `{n}` in its `replacement` causes it. A failure to read your user name, host name or git identity causes it too. | Check your `fixed` rules. Then type `/reload`. If the error stays, report it as an issue. |
| `NOT_STARTED` | The session has not started yet. | Wait, or type `/reload`. |
| `SESSION_SHUTDOWN` | The session is closing. | Start or open a session. |

A failed save of the vault always blocks the session until it reloads, because the save may have completed.

## Claude Code

With `lmsk claude`, the codes above have the same meaning, with these differences:

- The agent shows a stopped request as an API error with the text `lmsk: CODE`. `lmsk` writes a message to the terminal only when it blocks a session.
- There is no `/lmsk` command and no `/reload`. To clear a blocked session, correct the cause, then close the agent and start it again with `lmsk`.
- `/new` is a pi command. Start a new session of your agent instead.
- The vault folder is `~/.local/state/lmsk/vaults/`.

These messages occur only with Claude Code:

| What you see | Meaning | What to do |
|---|---|---|
| `lmsk: withheld. This tool call opened a protected path.` as a tool result | A Claude Code `Read`, `Write`, `Edit`, `Grep` or `Glob` call opened a protected path. The proxy withheld its result. | This is the normal protection. See [Default protected paths](CONFIGURATION.md#default-protected-paths). |
| `lmsk: withheld. This tool result holds a secret spaced out, wrapped, reversed or encoded.` as a tool result | The output holds a secret in a hidden form, such as reversed or encoded. The proxy withheld it from the provider. | If the output was ordinary text, you can set `withholdHiddenCopies` to `false` in `~/.config/lmsk/config.json`. See [Settings](CONFIGURATION.md#settings). |
| `lmsk: <path> is a protected path` as the reason that a tool call was refused | The deny hook refused a call that opens a protected path. | This is the normal protection. |
| `lmsk: hook failed: CODE.` | The deny hook could not read its input, so it refused the call. | Report the problem as an issue, with the code. |
| `lmsk: UPSTREAM` | The proxy could not reach the model provider. | Check your network connection, then send the request again. |
| `lmsk: FORBIDDEN` | A program sent a request to the proxy without its private address. | Start the agent with `lmsk`. Do not copy the proxy address into another program. |
| `lmsk: FORKED_SESSION` | The request holds tool calls of another session, such as after `claude --fork-session` or a branch of a conversation. The proxy cannot put back the fakes of those calls, so it sent nothing to the provider. | Start a new session, or resume the original session without forking it. |
| `lmsk: <file> sets ANTHROPIC_BASE_URL.` | A Claude Code settings file sends Claude Code to a gateway. The proxy would replace it with Anthropic. | Remove `ANTHROPIC_BASE_URL` from the file and set it in your shell. Then start `lmsk claude` again. |
| `CALLS_INVALID` | A file that keeps the tool calls of a session, in `~/.local/state/lmsk/sessions/`, does not hold a JSON object. The proxy reads the files of the other sessions to find a fork, so the invalid file can belong to another session. | Move the `.calls.json` file that is not valid JSON out of the folder. |
| `lmsk: claude is not on your PATH.` | `lmsk` did not find Claude Code. | Install Claude Code, or add its folder to your `PATH`. Then start `lmsk` again. |

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
