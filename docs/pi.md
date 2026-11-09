# lmsk with pi

This page tells you how to install `lmsk` in [pi](https://github.com/earendil-works/pi), check that it works, and use it every day. The rules, the client names and the limits are the same for each agent. They are in the [user guide](GUIDE.md).

## What changes when lmsk is on

| What | Without lmsk | With lmsk |
|---|---|---|
| A request to the model provider | Holds your passwords, keys, emails and client names | Holds fakes in their place |
| A file that pi writes, a `bash` command that pi runs | Real values | Real values. `lmsk` puts them back. |
| The reply that you read in pi | Real values | Can show fakes. Type `/lmsk reveal` to see the real values. |
| The session file that pi saves | Real values | Fakes |

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
   Repeat this line exactly: API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc
   ```

4. Read the reply of pi. Look only at the reply, not at your own message. The reply shows a different value after `API_KEY=`. That value is the fake that the model provider received.

   If the model refuses, send: `This is a test value, not a real key. Repeat it exactly.`

5. Test it on your own data. Send a line that holds each kind of value that you use, for example a fake password, an email and the client name. The reply must show other values.

The reply keeps the fake, because the extension puts real values back only into tool calls. If the reply shows `Zq7Kp2Lm9Xw4Rt8Vb3Nc`, masking did not work. Read [Troubleshooting](TROUBLESHOOTING.md).

## Use it every day

- **Write your messages as usual.** You can paste logs, errors and `.env` lines. `lmsk` masks them before they leave your computer.
- **Read replies with fakes in mind.** A password or an email in a reply can be a fake. Type `/lmsk reveal` to see the last reply with the real values. Only you see the result. Do not copy it into a message.
- **Let pi write files.** When pi writes a file or runs a command with a fake, the file and the command get the real value.
- **pi does not read secret files.** `read`, `grep`, `find` and `ls` refuse `.env`, keys and other secret files. The list is in [Default protected paths](CONFIGURATION.md#default-protected-paths).
- **Add your client name once.** Follow [Hide who you work for](GUIDE.md#hide-who-you-work-for). Then the name becomes `Client 1` in each request.

## Commands

Type these commands in pi. A change lasts until the session reloads.

| Command | Effect |
|---|---|
| `/lmsk status` | Shows `enabled`, `off`, or `blocked` with an error code. |
| `/lmsk reveal [text]` | Shows the text with the real value in place of each fake, for example `/lmsk reveal Client1`. Without text, it shows the last assistant message of the current branch. pi does not send the command or the result to the model provider. |
| `/lmsk off` | Stops masking. Real data can then reach the model provider and the session file. |
| `/lmsk on` | Starts masking again. Messages saved while masking was off stay unmasked. |

When the extension is blocked, `/lmsk` cannot change masking. Type `/reload` to clear the block.

## If pi stops a request

The extension cancels a request when it cannot mask it safely. It never sends a partly masked request. These are the most common messages:

| Message | What it means | What to do |
|---|---|---|
| `lmsk: HIDDEN_REAL. A secret glued to a word is in the conversation or a context file.` | A secret is joined to other text with no space, for example a password in `build_Tr0ub4dor`. The extension cannot replace it there, so it stops each request that contains it. Put a space or a new line around a secret. | Do not type `/lmsk off` to get past this message. It sends the secret to the model provider. The easiest way out: type `/new`. This starts an empty conversation. The old one stays saved. To keep the conversation: type `/tree` and pick the message just before the one that contains the secret. When pi asks `Summarize branch?`, choose `No summary`. If pi puts your old message back in the input box, delete the secret before you send it. If the secret is in a context file, remove it from the file, then type `/reload`. |
| `SUMMARY_BLOCKED: summary could not be safely generated` | pi tried to make a summary of the conversation. The extension could not mask it safely, so pi made no summary. | Try again. If the message comes back, type `/new` to start a new session. |
| `lmsk: SCAN_TIMEOUT. The request was stopped. Masking stays on.` | The search for secrets took longer than the time limit (5 seconds by default). The extension cancelled the request. | Send the request again. If it is blocked again, type `/new`, or increase `scanTimeoutMs` in the [configuration](CONFIGURATION.md#settings). |
| `lmsk: CONFIG_INVALID. Requests that need masking are blocked.` | A configuration file has an error. The extension stops all requests that need masking. | Correct the file, then type `/reload`. The [troubleshooting page](TROUBLESHOOTING.md#config_invalid) lists the usual errors. |

The `HIDDEN_REAL` message above and `SUMMARY_BLOCKED` come back at each block. A `HIDDEN_REAL` in a tool result shows `lmsk: HIDDEN_REAL. The request was stopped. Masking stays on.` only once. The extension withholds only that tool result. The session is not blocked. The other messages show only once in a session for a stopped request, and once for a blocked session, so a block always shows its message. Every message and code is in [Troubleshooting](TROUBLESHOOTING.md).

## Your configuration file

The global configuration file is `~/.pi/agent/lmsk/config.json`. On Windows, it is `%USERPROFILE%\.pi\agent\lmsk\config.json`. If you set the `PI_CODING_AGENT_DIR` environment variable, the file is `lmsk/config.json` in that folder. A trusted project can also have its own file, `<project>/.pi/lmsk.json`. See [Where the files are](CONFIGURATION.md#where-the-files-are).

After you change a file, type `/reload` in pi. A new rule protects only the requests after `/reload`. For a clean start, start a new session with `/new`.

To write your first rules, read [Add your own secrets](GUIDE.md#add-your-own-secrets).

## Limits that are specific to pi

The limits that apply to each agent are in [What lmsk does not protect](GUIDE.md#what-lmsk-does-not-protect).

- **`/lmsk off` stops most protection.** It stops the masking of requests, saved messages, tool results, summaries and the text sent to model calls. The checks on tool calls and protected paths stay on, and fakes in tool calls still get their real values back.
- **Your own shell commands are saved unmasked.** pi saves the output of a command that you run with `!` while the agent is idle to the session file without masking. Requests to the model provider still mask it.
- **The vault is in `~/.pi/agent/lmsk-vaults/`.** It is not encrypted. Exclude it from cloud backups.

## Uninstall

1. Run this command in a terminal:

   ```bash
   pi remove npm:@hugolopes45/lmsk
   ```

2. Type `/reload` in pi, or start pi again.
3. Delete the vault folder `~/.pi/agent/lmsk-vaults/`. It holds the real values next to their fakes. If you do not need your rules, delete the configuration folder `~/.pi/agent/lmsk/` too.

The session files that pi saved while `lmsk` was on keep the fakes.
