# lmsk with pi

This page tells you how to install `lmsk` in [pi](https://github.com/earendil-works/pi), check that it works, and use it every day. The rules, the client names and the limits are the same for each agent. They are in the [user guide](GUIDE.md).

## What changes when lmsk is on

| What | Without lmsk | With lmsk |
|---|---|---|
| A request to the model provider | Holds your passwords, keys, emails and client names | Holds fakes in their place |
| A file that pi writes, a `bash` command that pi runs | Real values | Real values. `lmsk` puts them back. |
| The reply that you read in pi | Real values | Real values when the reply ends. Thinking text and some short or glued values keep their fakes. Type `/lmsk reveal` to see their real values. |
| The session file that pi saves | Real values | Real values. Thinking text, and some short or glued values in replies and summaries, keep their fakes. |

You work as usual. You do not type anything special in your messages.

## Install

1. Install pi. Follow the steps in the [pi documentation](https://github.com/earendil-works/pi).
2. Open a terminal and run this command:

   ```bash
   pi install npm:@hugolopes45/lmsk
   ```

3. Start pi:

   ```bash
   pi
   ```

   If pi is already open, type `/reload` in pi, or close pi and start it again.

The extension works with no configuration.

Load only one copy of this extension in a session. If you installed it only with the command above, you have one copy. To load a copy from the source code, read [CONTRIBUTING.md](../CONTRIBUTING.md).

## Check that it works

1. In pi, type `/lmsk status` and press Enter.
2. Make sure that pi shows a line that starts with `lmsk: enabled.`

   If pi says that it does not know `/lmsk`, the extension is not loaded. Run `pi list` in a terminal. It must show `lmsk`.

3. Send this message to pi. The key in it is a test value, not a real key:

   ```text
   Spell the value after API_KEY= with a space between each character: API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc
   ```

4. Read the reply of pi. It spells the fake that the model provider received, so it does not start with `Z q 7 K p 2`. The extension puts back only whole fakes, so a spelled fake stays visible.

   If the model refuses, send: `This is a test value, not a real key. Spell it.`

5. Test it on your own data. Send a line that holds each kind of value that you use, for example a test password, an email and the client name. Ask the model to spell each value with spaces. The reply must spell other values.

If the reply spells `Z q 7 K p 2 L m 9 X w 4 R t 8 V b 3 N c`, masking did not work. Read [Troubleshooting](TROUBLESHOOTING.md).

## Use it every day

- **Write your messages as usual.** You can paste logs, errors and `.env` lines. `lmsk` masks them before they leave your computer.
- **Read replies as usual.** pi shows the real values when a reply ends, and can show fakes while the reply streams. Thinking text keeps its fakes, and so does a value that the model glues to a letter, a digit or `_`. A value under 8 characters keeps its fake too, unless it is a value of a `literal` or `env` rule. Type `/lmsk reveal` to see the last reply with each real value. For thinking text, type `/lmsk reveal` and the text.
- **Let pi write files.** When pi writes a file or runs a command with a fake, the file and the command get the real value.
- **pi does not open secret files.** `read`, `grep`, `find`, `ls`, `write` and `edit` refuse `.env`, keys and other secret files. A `bash` or `powershell` command that names one is refused too. The list is in [Default protected paths](CONFIGURATION.md#default-protected-paths).
- **Add your client name once.** Follow [Hide who you work for](GUIDE.md#hide-who-you-work-for). Then the name becomes `Client 1` in each request.

## Commands

Type these commands in pi. A change lasts until the session reloads.

| Command | Effect |
|---|---|
| `/lmsk status` | Shows `enabled`, `off`, or `blocked` with an error code. |
| `/lmsk reveal [text]` | Shows the text with the real value in place of each fake, for example `/lmsk reveal Client1`. Without text, it shows the last assistant message of the current branch. pi does not send the command or the result to the model provider. |
| `/lmsk off` | Stops masking. The model provider then gets real values. |
| `/lmsk on` | Starts masking again. The model provider keeps the real values that pi sent while masking was off. |

When the extension is blocked, `/lmsk` cannot change masking. Type `/reload` to clear the block.

## If pi stops a request

The extension cancels a request when it cannot mask it safely. It never sends a partly masked request. These are the most common messages:

| Message | What it means | What to do |
|---|---|---|
| `lmsk: HIDDEN_REAL. A secret glued to a word is in the conversation or a context file.` | A token with a known prefix, or a value of a `mask` or `block` rule, is joined to a word with no space. An example is `x` before a GitHub token. The extension cannot replace it there, so it stops each request that contains it. Put a space or a new line around a secret. | Do not type `/lmsk off` to get past this message. It sends the secret to the model provider. The easiest way out: type `/new`. This starts an empty conversation. The old one stays saved. To keep the conversation: type `/tree` and pick the message just before the one that contains the secret. When pi asks `Summarize branch?`, choose `No summary`. If pi puts your old message back in the input box, delete the secret before you send it. If the secret is in a context file, remove it from the file, then type `/reload`. |
| `SUMMARY_BLOCKED: summary could not be safely generated` | pi tried to make a summary of the conversation. The extension could not mask it safely, so pi made no summary. | Try again. If the message comes back, type `/new` to start a new session. |
| `lmsk: SCAN_TIMEOUT. The request was stopped. Masking stays on.` | The search for secrets took longer than the time limit (5 seconds by default). The extension cancelled the request. | Send the request again. If it is blocked again, type `/new`, or increase `scanTimeoutMs` in the [configuration](CONFIGURATION.md#settings). |
| `lmsk: CONFIG_INVALID. Requests that need masking are blocked.` | A configuration file has an error. The extension stops all requests that need masking. | Correct the file, then type `/reload`. The [troubleshooting page](TROUBLESHOOTING.md#config_invalid) lists the usual errors. |

The `HIDDEN_REAL` message above and `SUMMARY_BLOCKED` come back at each block. The other messages show only once in a session for a stopped request, and once for a blocked session. So a block always shows its message. Every message and code is in [Troubleshooting](TROUBLESHOOTING.md).

A text that holds a known secret spaced out, wrapped, reversed or encoded does not stop the request. The model provider gets `lmsk: withheld. This text holds a secret spaced out, wrapped, reversed or encoded.` in its place. pi still shows you the real text.

## Your configuration file

The global configuration file is `~/.pi/agent/lmsk/config.json`. On Windows, it is `%USERPROFILE%\.pi\agent\lmsk\config.json`. If you set the `PI_CODING_AGENT_DIR` environment variable, the file is `lmsk/config.json` in that folder. A trusted project can also have its own file, `<project>/.pi/lmsk.json`. See [Where the files are](CONFIGURATION.md#where-the-files-are).

After you change a file, type `/reload` in pi. A new rule protects only the requests after `/reload`. For a clean start, start a new session with `/new`.

To write your first rules, read [Add your own secrets](GUIDE.md#add-your-own-secrets).

## Limits that are specific to pi

The limits that apply to each agent are in [What lmsk does not protect](GUIDE.md#what-lmsk-does-not-protect).

- **`/lmsk off` stops most protection.** It stops the masking of requests, summaries and the text sent to model calls. The checks on tool calls and protected paths stay on, and fakes in tool calls still get their real values back.
- **The session file holds real values.** Thinking text, and some short or glued values in replies and summaries, keep their fakes. Requests to the model provider mask them, but `/bug` does not. Its summary goes to the model provider, and its report can hold the session file.
- **lmsk masks the model calls of other extensions only through the model registry.** These are the calls to `stream`, `streamSimple`, `complete`, `classify` and `generateImages` of `ctx.modelRegistry`. lmsk does not mask other calls, for example a provider stream from `getProvider()` or a network request of the extension. It also does not mask a call that an extension makes before the `session_start` handler of lmsk runs. The reply to a masked call keeps its fakes. If another extension also writes the compaction summary, pi keeps the summary of the extension that loads last.
- **The vault is in `~/.local/state/lmsk/`**, or in `lmsk/` in `XDG_STATE_HOME` if you set it. Claude Code uses the same vault. It is not encrypted. Exclude it from cloud backups.

## Uninstall

1. Run this command in a terminal:

   ```bash
   pi remove npm:@hugolopes45/lmsk
   ```

2. Type `/reload` in pi, or start pi again.
3. If you do not use `lmsk` with Claude Code, delete the vault folder `~/.local/state/lmsk/`. It holds the real values next to their fakes. If you do not need your rules, delete the configuration folder `~/.pi/agent/lmsk/` too.

Older versions of the extension kept their vaults in `~/.pi/agent/lmsk-vaults/`. This version does not use that folder. You can delete it. The session files that older versions saved keep their fakes.
