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
| `protected path` as the reason that a tool call was refused | The agent tried to `read`, `grep`, `find`, `ls`, `write` or `edit` a protected file, such as `.env`, or a `bash` command named one. | This is the normal protection. To allow a path, remove its glob with `!` in the global configuration. See [Default protected paths](CONFIGURATION.md#default-protected-paths). |
| A shell command is refused with `protected path`, but it opens no protected file | Each word of the command that is a protected path counts. So `git commit -m "add .env to .gitignore"`, `cp .env.example .env` and `find . -name "*.pem"` are refused. | Run the command yourself, or write it without that word. A `write` or `edit` of `.env.example` is refused too, because `**/.env*` matches it. |
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
| `VAULT_FULL` | The vault of the session has 50000 values, or its values have 2000000 characters together, or its file `vault.jsonl` has a size of 32 MiB. This is the maximum. | [Start a new vault](#start-a-new-vault). |
| `VAULT_COLLISION` | The extension found no unused fake for a value, or a line of the vault of the session gives one fake to two values. | Send the request again. If the error comes back, [start a new vault](#start-a-new-vault). |
| `VAULT_ENDED` | The conversation holds a tool call that the vault of the session did not restore: its vault ended because the session ended or no request used it for one hour, or, with Claude Code, the call came in a reply that was not streamed. lmsk no longer knows the real values that the call got back, so it cannot mask them. | Go back to a point before the tool calls: in pi, type `/tree`; in Claude Code, type `/rewind`, then choose `Restore conversation`. Or [start a new session](#start-a-new-vault). |

## Code that stops a reply

With Claude Code, the reply ends early. The proxy writes `lmsk: a reply stopped: <code>` to its messages: `serve.log` in the state folder on macOS, or `journalctl --user -u lmsk.service` on Linux.

| Code | Meaning | What to do |
|---|---|---|
| `STREAM_INVALID` | The model provider sent a reply that the agent and lmsk could read in two ways. An event name is not the type of its data, a block index is not a whole number, or a block starts at an index that is still open. | Send the request again. If the error comes back, check your gateway. Then report the problem as an issue. Do not include secrets. |

## Codes that block the session

The state folder of lmsk is `~/.local/state/lmsk/`, or `lmsk/` in `XDG_STATE_HOME` if you set it. Each session has its own vault in a folder in `session-vaults/` in the state folder. The vault is the file `vault.jsonl`, which keeps each real value next to its fake, encrypted with the `key` file in the same folder. The key also makes the fakes.

| Code | Meaning | What to do |
|---|---|---|
| `CONFIG_INVALID` | A configuration file has an error. See [CONFIG_INVALID](#config_invalid). | Correct the file, then type `/reload`. |
| `STORE_BUSY` | Another process held `vault.lock`, the lock of the vault, for more than 2 seconds. Or the lock has no owner that lmsk knows, for example after a process stopped while it took or released the lock. | Type `/reload`. If the error comes back, [start a new vault](#start-a-new-vault). |
| `STORE_UNSAFE` | The vault folder of the session, or the `vault.jsonl` or `key` file in it, has wrong permissions or a wrong owner. The folder must have mode 700 and the files mode 600, all owned by your user. | On macOS or Linux, run `chmod 700` on the folder and `chmod 600` on the files. Then type `/reload`. |
| `STORE_CORRUPT` | A line of `vault.jsonl` is not valid or does not decrypt with the `key` file, another process changed `vault.jsonl` while lmsk used it, or the `key` file has a wrong length. | Send the request again. If the error comes back, [start a new vault](#start-a-new-vault). |
| `STORE_IO` | The computer could not read or write the vault file, for example because the disk is full. | Correct the disk problem, then type `/reload`. |
| `UNEXPECTED_ERROR` | Another error. A `fixed` rule without `{n}` in its `replacement` causes it. A failure to read your user name, host name or git identity causes it too. | Check your `fixed` rules. Then type `/reload`. If the error stays, report it as an issue. |
| `NOT_STARTED` | The session has not started yet. | Wait, or type `/reload`. |
| `SESSION_SHUTDOWN` | The session is closing. | Start or open a session. |

After you upgrade lmsk, start each pi session again. If you use Claude Code, also run `lmsk install claude` again. It starts the proxy with the new version.

A failed read or save of the vault during a request stops only that request. But a line of `vault.jsonl` that is not valid stops each later request of the session with `STORE_CORRUPT` or `VAULT_COLLISION`, until you [start a new vault](#start-a-new-vault). The next save removes a last line that a stopped process did not finish.

A vault of another session that lmsk cannot delete does not stop your session. lmsk shows `an idle vault was not deleted: <code>`. Correct the permissions of the folders in `session-vaults/`. The next session start deletes the vault.

### Start a new vault

Start a new session. In pi, type `/new`. With Claude Code, quit, then run `claude` again. The new session gets a new, empty vault. lmsk deletes the vault of the old session when the session ends. A vault that no session used for one hour is deleted about one minute later, or at the next request or session start.

The old conversation keeps its fakes: lmsk no longer puts its real values back.

## Claude Code

With Claude Code, the codes above have the same meaning, with these differences:

- Claude Code shows a stopped request as an API error with the text `lmsk: CODE`, for example `API Error: 400 lmsk: SCAN_TIMEOUT`.
- There is no `/lmsk` command and no `/reload`. To clear a block, correct the cause. The next request opens the config again, so the proxy does not need a restart.
- If the proxy stopped, for example with `PORT_TAKEN` or `TOKEN_CORRUPT`, correct the cause, then run `lmsk install claude`. It starts the proxy again.
- Where this page says `/tree`, type `/rewind`, then choose `Restore conversation`.
- The proxy writes its messages to `serve.log` in the state folder on macOS. On Linux, run `journalctl --user -u lmsk.service`.

These messages occur only with Claude Code:

| What you see | Meaning | What to do |
|---|---|---|
| `lmsk: <path> is a protected path` as the reason that a tool call was refused | The hook refused a call that opens a protected path. | This is the normal protection. See [Default protected paths](CONFIGURATION.md#default-protected-paths). |
| `lmsk: hook failed: CODE.` | The hook failed, for example on an input that it cannot read. Claude Code then refuses the call. | Report the problem as an issue, with the code. |
| `lmsk: UPSTREAM` | The proxy could not reach Anthropic or your gateway. | Check your network connection, then send the request again. |
| `lmsk: FORBIDDEN` | A program sent a request to the proxy without its private token. The proxy logs only the first such request after it starts. | Run `lmsk install claude`, then restart Claude Code. Do not copy the proxy address into another program. |
| `Connection refused` (`ECONNREFUSED`) | The proxy does not run. | Run `lmsk install claude`. If the error comes back, read the messages of the proxy. |
| `lmsk: CLAUDE_CONFIG_DIR_INVALID: CLAUDE_CONFIG_DIR must be an absolute path.` from `lmsk install claude` | `CLAUDE_CONFIG_DIR` is a relative path. Claude Code would read the settings of another folder in each session and send your requests past the proxy. | Set `CLAUDE_CONFIG_DIR` to an absolute path, or unset it, then run the command again. |
| `lmsk: SETTINGS_INVALID: <detail>.` from `lmsk install claude` | Your user settings file is not JSON, or one of its keys that lmsk changes has a wrong type. | Correct the file, then run the command again. |
| `lmsk: SERVICE_FAILED: <command> exited <number>.` from `lmsk install claude` | `launchctl` or `systemctl` could not start the service. | Read the output of the command above the message. Correct the cause, then run the command again. |
| `lmsk: INSTALL_NOT_CONFIRMED: run lmsk install claude in a terminal and answer yes.` from `lmsk install claude` | The command must save a new gateway address or write a new service file. It asks only when standard input and error output are terminals. Without a terminal, or if you did not answer yes, nothing changed. | Run `lmsk install claude` in a terminal, then answer `yes`. |
| `lmsk: SERVICE_VALUE_INVALID: a folder or a path holds a control character.` from `lmsk install claude` on Linux | The path to Node.js or to lmsk, or the folder in `XDG_CONFIG_HOME`, `XDG_STATE_HOME` or `CLAUDE_CONFIG_DIR`, holds a line break or another control character. | Rename the folder or change the variable, then run the command again. |
| `lmsk: PLATFORM_UNSUPPORTED: lmsk runs on macOS and Linux.` | Your operating system is not macOS or Linux. | Use pi, or use Claude Code on macOS or Linux. |
| `lmsk: SESSION_ID_MISSING` | A request to the proxy has no `X-Claude-Code-Session-Id` header. lmsk needs it to give each session its own vault. Claude Code sends it. | Update Claude Code. Do not send requests to the proxy from another program. |
| `TOKEN_CORRUPT` in the messages of the proxy | The file `serve-token` in the state folder is not valid. | Delete the file, run `lmsk install claude`, then restart Claude Code. |
| `lmsk: serve stopped: PORT_TAKEN.` | Another program uses the port of the proxy, 25675. The proxy does not start. | See [PORT_TAKEN](#port_taken). |

## PORT_TAKEN

`lmsk serve` stops with `lmsk: serve stopped: PORT_TAKEN.` when another program listens on the port of the proxy, 25675. Find the program with this command:

```text
lsof -i :25675
```

The output shows the process ID and the name of the program. Stop that program, or wait until it stops. If the program is another `lmsk serve`, stop it first. Then run `lmsk install claude` to start the proxy again.

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
