# lmsk with Claude Code

This page tells you how to install `lmsk` for Claude Code, check that it works, and use it every day. The rules, the client names and the limits are the same for each agent. They are in the [user guide](GUIDE.md).

This support is a preview.

## What changes when lmsk is on

You start Claude Code with `lmsk claude` in place of `claude`. `lmsk` then starts a proxy on your computer. Claude Code sends each request to the proxy, and the proxy masks the request before it goes to Anthropic.

| What | Without lmsk | With lmsk |
|---|---|---|
| A request to Anthropic | Holds your passwords, keys, emails and client names | Holds fakes in their place |
| A file that Claude Code writes, a command that it runs | Real values | Real values. `lmsk` puts them back. |
| The reply that you read in Claude Code | Real values | Can show fakes |
| The conversation files of Claude Code (`~/.claude/projects/`) | Real values | Real values |

Your Claude Code configuration does not change. `claude` started alone, without `lmsk`, sends real values.

## Install

1. Install Node.js 22.19 or later.
2. Install Claude Code 2.1.295 or later.
3. Run this command in a terminal:

   ```bash
   npm install -g @hugolopes45/lmsk
   ```

## Start Claude Code through lmsk

```bash
lmsk claude
```

Arguments after `claude` go to Claude Code. For example, `lmsk claude --continue` continues your last conversation, and `lmsk claude -p "Fix the failing test"` runs one prompt.

Use `lmsk claude` each time. To make this easy, you can add an alias in your shell, for example `alias claude='lmsk claude'`.

## Check that it works

1. Start Claude Code with `lmsk claude`.
2. Send this message. The key in it is a test value, not a real key:

   ```text
   Repeat this line exactly: API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc
   ```

3. Read the reply. Look only at the reply, not at your own message. The reply shows a different value after `API_KEY=`. That value is the fake that Anthropic received.

   If the model refuses, send: `This is a test value, not a real key. Repeat it exactly.`

4. Test it on your own data. Send a line that holds each kind of value that you use, for example a fake password, an email and the client name. The reply must show other values.

If the reply shows `Zq7Kp2Lm9Xw4Rt8Vb3Nc`, masking did not work. Make sure that you started Claude Code with `lmsk claude`, then read [Troubleshooting](TROUBLESHOOTING.md#claude-code).

## Use it every day

- **Write your messages as usual.** You can paste logs, errors and `.env` lines. `lmsk` masks them before they leave your computer.
- **Read replies with fakes in mind.** A password or an email in a reply can be a fake. There is no command to show the real value.
- **Let Claude Code write files.** When `Read`, `Write`, `Edit`, `Grep`, `Glob` or `Bash` gets a fake, `lmsk` gives it the real value. Other tools, such as MCP tools, get fakes.
- **Claude Code does not read secret files.** A deny hook refuses a tool call that opens `.env`, keys and other secret files, and tells Claude Code why. You do nothing. The list is in [Default protected paths](CONFIGURATION.md#default-protected-paths).
- **Add your client name once.** Follow [Hide who you work for](GUIDE.md#hide-who-you-work-for). Then the name becomes `Client 1` in each request.

## If a request stops

`lmsk` cancels a request when it cannot mask it safely. It never sends a partly masked request. Claude Code shows an API error with a text such as `lmsk: SCAN_TIMEOUT`.

| Message | What to do |
|---|---|
| `lmsk: HIDDEN_REAL` | A secret is joined to other text with no space, for example a password in `build_Tr0ub4dor`. Type `/rewind` and go back to a message before the secret, or start a new session. Put a space or a new line around a secret. |
| `lmsk: SCAN_TIMEOUT` | Send the request again. If it is blocked again, start a new session, or increase `scanTimeoutMs` in the [configuration](CONFIGURATION.md#settings). |
| `lmsk: CONFIG_INVALID` | Correct the configuration file, then close Claude Code and start it again with `lmsk claude`. |
| `lmsk: UPSTREAM` | The proxy could not reach Anthropic. Check your network connection, then send the request again. |

Every message and code is in [Troubleshooting](TROUBLESHOOTING.md#claude-code).

## Your configuration file

The configuration file is `~/.config/lmsk/config.json`. If you set `XDG_CONFIG_HOME`, the file is `lmsk/config.json` in that folder. It has the same format as the pi file, with these differences:

- There is no project file.
- The default `restoredTools` are `Read`, `Write`, `Edit`, `Grep`, `Glob` and `Bash`.

The proxy reads the file when a session starts. After you change it, close Claude Code and start it again with `lmsk claude`.

To write your first rules, read [Add your own secrets](GUIDE.md#add-your-own-secrets).

## What lmsk changes in the Claude Code session

`lmsk claude` gives Claude Code the proxy address in the session settings, which win over your user and project settings. It changes nothing on disk in `~/.claude`.

- **Other providers are off.** `lmsk claude` turns off the Amazon Bedrock, Google Cloud Agent Platform, Microsoft Foundry and Claude Platform on AWS providers for the session, because the proxy cannot mask their requests.
- **Your gateway stays.** A gateway that you set in `ANTHROPIC_BASE_URL` in your shell stays behind the proxy. If a settings file sets `ANTHROPIC_BASE_URL`, `lmsk claude` refuses to start, because the proxy would send the requests and your gateway credentials to Anthropic. Set the gateway in your shell.
- **Managed settings win.** Managed settings of your organization win over the session settings, so a managed `ANTHROPIC_BASE_URL` sends requests past the proxy.
- **No `--settings`.** `lmsk claude` refuses your own `--settings`, because Claude Code would use it in place of the session settings. Put your settings in `~/.claude/settings.json`.
- **Hooks are on.** `lmsk claude` sets `disableAllHooks` to `false` for the session, so a settings file cannot turn off the deny hook. This also turns on the other hooks that you turned off with `disableAllHooks`.

### How the deny hook works

`lmsk claude` loads the hook for the session, and also gives Claude Code one `Read` deny rule per protected path in the session settings. These rules also refuse a recognized shell file command, such as `cat .env`, and a file that you add to a prompt with `@`, which no hook sees. If Claude Code cannot start the hook, it refuses the call.

The proxy also withholds the result of a Claude Code `Read`, `Write`, `Edit`, `Grep` or `Glob` call on a protected path. The agent then sees only `lmsk: withheld.`

The hook checks the `file_path` or `path` of each Claude Code file tool and each word of a shell command. It does not check the `glob` of a `Grep` or `Glob` call, so a search of a folder can find a protected file in it. Claude Code applies the `Read` deny rules to `Grep` and `Glob` as a best effort. The hook reads a shell command as a word list, not with a parser: a path in quotes with a space in it, a variable, another user's `~name` or another program can hide a path from it.

## Limits that are specific to Claude Code

The limits that apply to each agent are in [What lmsk does not protect](GUIDE.md#what-lmsk-does-not-protect).

- **There is no `/lmsk` command.** You cannot see the status, reveal a fake or stop masking. `lmsk` writes a message to the terminal only when it blocks a session.
- **Claude Code saves real values on your computer.** The proxy changes only what goes to Anthropic. The conversation files of Claude Code (`~/.claude/projects/`) keep the real tool output.
- **A hidden copy can stay in an earlier tool result.** The proxy withholds a tool result that holds a secret spaced out, wrapped, reversed or encoded. If lmsk learns the secret only after the output, the earlier requests already sent the output. Claude Code still shows you the real output.
- **The proxy knows a tool only by its name.** A tool with the name of a built-in tool gets real values too.
- **Tools that run at Anthropic see fakes.** A web search that Anthropic runs uses the masked text.
- **The vault is in `~/.local/state/lmsk/vaults/`**, or in `lmsk/vaults/` in `XDG_STATE_HOME` if you set it. It is not encrypted. Exclude it from cloud backups.

## Uninstall

1. Run `npm uninstall -g @hugolopes45/lmsk`.
2. Delete the folder `~/.local/state/lmsk/`. It holds the vaults and the tool calls of each session. If you do not need your rules, delete `~/.config/lmsk/` too.
