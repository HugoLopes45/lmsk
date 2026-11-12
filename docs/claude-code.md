# lmsk with Claude Code

This page tells you how to install `lmsk` for Claude Code, check that it works, and use it every day. The rules, the client names and the limits are the same for each agent. They are in the [user guide](GUIDE.md).

## What changes when lmsk is on

`lmsk install claude` starts a proxy on your computer as a service. The service starts the proxy when you log in, and starts it again if it stops. Your Claude Code user settings send each request to the proxy. The proxy masks the request before it goes to Anthropic, and puts the real values back into the reply.

| What | Without lmsk | With lmsk |
|---|---|---|
| A request to Anthropic | Holds your passwords, keys, emails and client names | Holds fakes in their place |
| A file that Claude Code writes, a command that it runs | Real values | Real values. `lmsk` puts them back. |
| The reply that you read in Claude Code | Real values | Real values. Thinking text and some short or glued values keep their fakes. |
| The conversation files of Claude Code (`~/.claude/projects/`) | Real values | Real values |

You start Claude Code with `claude`, as usual.

## Install

1. Use macOS or Linux. Install Node.js 22.19 or later.
2. Install Claude Code 2.1.295 or later.
3. If you use a gateway, set `ANTHROPIC_BASE_URL` to its address in your shell or in your user settings.
4. Run these commands in a terminal:

   ```bash
   npm install -g @hugolopes45/lmsk
   lmsk install claude
   ```

5. Make sure that the last line is `lmsk: Claude Code now sends its requests through the proxy. Restart the Claude Code sessions that run.`
6. Close each Claude Code session that runs, then start it again.

`lmsk install claude` saves the gateway address of step 3. The proxy then sends the requests to your gateway, not to Anthropic. To stop using the gateway, remove `ANTHROPIC_BASE_URL` from your shell, delete the file `upstream` in the [vault folder](#what-lmsk-install-claude-changes), then run `lmsk install claude`.

Run `lmsk install claude` again after each of these changes. The command starts the service again with the new files.

- You update `lmsk` or Node.js. The service runs the exact Node.js and `lmsk` files that were installed when you ran the command.
- You change the configuration file. The proxy reads it only when it starts.
- You start to use a gateway, or change it. Set its address as in step 3 first. Until you run the command, a gateway in your shell gets no requests: the proxy sends them to Anthropic, with the credentials of your gateway. A gateway in your user settings gets the requests without the proxy.

## Check that it works

1. Start Claude Code with `claude`.
2. Send this message. The key in it is a test value, not a real key:

   ```text
   Spell the value after API_KEY= with a space between each character: API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc
   ```

3. Read the reply. It spells the fake that Anthropic received, so it does not start with `Z q 7 K p 2`. `lmsk` puts back only whole fakes, so a spelled fake stays visible.

   If the model refuses, send: `This is a test value, not a real key. Spell it.`

4. Test it on your own data. Send a line that holds each kind of value that you use, for example a test password, an email and the client name. Ask the model to spell each value with spaces. The reply must spell other values.

If the reply spells `Z q 7 K p 2 L m 9 X w 4 R t 8 V b 3 N c`, masking did not work. Read [Troubleshooting](TROUBLESHOOTING.md#claude-code).

## Use it every day

- **Start Claude Code as usual.** Type `claude`. Each session sends its requests through the proxy.
- **Write your messages as usual.** You can paste logs, errors and `.env` lines. `lmsk` masks them before they leave your computer.
- **Read replies as usual.** Replies show real values. Thinking text keeps its fakes. A value under 8 characters also keeps its fake, unless it is a value of a `literal` or `env` rule. A value that the model glues to a letter, a digit or `_` keeps its fake too.
- **Let Claude Code write files.** When `Read`, `Write`, `Edit`, `Grep`, `Glob` or `Bash` gets a fake, `lmsk` gives it the real value. Other tools, such as MCP tools and `WebFetch`, get fakes. A `Bash` command that uses the network, such as `curl`, gets fakes too.
- **Claude Code does not read secret files.** A hook refuses a tool call that opens `.env`, keys and other secret files, and tells Claude Code why. You do nothing. The list is in [Default protected paths](CONFIGURATION.md#default-protected-paths).
- **Add your client name once.** Follow [Hide who you work for](GUIDE.md#hide-who-you-work-for). Then the name becomes `Client 1` in each request.

## If a request stops

`lmsk` stops a request when it cannot mask it safely. It never sends a partly masked request. Claude Code shows an API error with a text such as `400 lmsk: SCAN_TIMEOUT`.

| Message | What to do |
|---|---|
| `lmsk: HIDDEN_REAL` | A token with a known prefix, or a value of a `mask` or `block` rule, is glued to a word. Type `/rewind` and go back to a message before the secret, or start a new session. Put a space or a new line around a secret. |
| `lmsk: SCAN_TIMEOUT` | Send the request again. If it is blocked again, start a new session, or increase `scanTimeoutMs` in the [configuration](CONFIGURATION.md#settings). |
| `lmsk: CONFIG_INVALID` | Correct the configuration file, then run `lmsk install claude`. |
| `lmsk: UPSTREAM` | The proxy could not reach Anthropic or your gateway. Check your network connection, then send the request again. |
| `Connection refused` (`ECONNREFUSED`) | The proxy does not run. Run `lmsk install claude` to start it again. |

Every message and code is in [Troubleshooting](TROUBLESHOOTING.md#claude-code).

## Your configuration file

The configuration file is `~/.config/lmsk/config.json`. If `XDG_CONFIG_HOME` was set when you ran `lmsk install claude`, the file is `lmsk/config.json` in that folder. It has the same format as the pi file, with these differences:

- There is no project file.
- The default `restoredTools` are `Read`, `Write`, `Edit`, `Grep`, `Glob` and `Bash`.
- An `env` rule reads only the environment of the service. The service does not get the variables of your terminal, so an `env` rule does not find them.

The proxy reads the file when it starts. After you change it, run `lmsk install claude`.

To write your first rules, read [Add your own secrets](GUIDE.md#add-your-own-secrets).

## What lmsk install claude changes

`lmsk install claude` writes these files:

- **Your user settings**, `~/.claude/settings.json`, or `settings.json` in `CLAUDE_CONFIG_DIR` if you set it. Other keys do not change.
  - `env.ANTHROPIC_BASE_URL` gets the proxy address: `http://127.0.0.1:25675/` and a private token.
  - `env.CLAUDE_CODE_MAX_RETRIES` gets `3` if your user settings do not set it, so that a proxy error shows sooner.
  - `env.NO_PROXY` and `env.no_proxy` get `127.0.0.1` added to their value, so that your HTTP proxy does not get the requests to `lmsk`.
  - `env.CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE` and `CLAUDE_CODE_USE_ANTHROPIC_AWS` get an empty value. This turns off the other providers, because the proxy cannot mask their requests.
  - `permissions.deny` gets one `Read` rule for each protected path.
  - `hooks.PreToolUse` gets the hook of `lmsk`. It replaces a hook of an earlier `lmsk install claude`.
- **The service file.** On macOS, it is `~/Library/LaunchAgents/io.github.hugolopes45.lmsk.plist`. On Linux, it is `~/.config/systemd/user/lmsk.service`.
- **The vault folder**, `~/.local/state/lmsk/`, or `lmsk/` in `XDG_STATE_HOME` if it was set. It gets `serve-token`, the private token of the proxy, and `upstream`, the address of your gateway.

### Settings that send requests past the proxy

Claude Code uses the setting with the highest precedence. These settings win over your user settings:

- **Managed settings** of your organization. A managed `ANTHROPIC_BASE_URL` sends the requests past the proxy.
- **A `--settings` file or JSON** that sets `ANTHROPIC_BASE_URL`.
- **A project settings file**, `.claude/settings.json` or `.claude/settings.local.json`, that sets `ANTHROPIC_BASE_URL`.
- **A project settings file that turns on another provider**, for example with `CLAUDE_CODE_USE_BEDROCK` set to `1`.
- **A project settings file that sets `NO_PROXY`** without `127.0.0.1`. Then an HTTP proxy that you use can get the requests before `lmsk` masks them.

Then Claude Code sends the real values to the provider. Do not set these keys in these files. A value that you export in your shell does not win: your user settings overwrite it.

A Claude Code process that does not read your user settings also sends the requests past the proxy. Examples are another `CLAUDE_CONFIG_DIR`, another user account, a container and CI.

`disableAllHooks: true` in a settings file turns off the hook of `lmsk`.

### How the hook works

The hook checks the `file_path` or `path` of each Claude Code file tool and each word of a shell command. If Claude Code cannot start the hook, it refuses the call.

The `Read` deny rules also refuse a file command that Claude Code recognizes in a shell command, such as `cat .env`. Claude Code also tries to apply them to a file that you add to a prompt with `@`, which no hook sees.

A tool call with a fake path that becomes a protected path after restore keeps its fakes. So it does not open the protected file.

The hook does not check the `glob` of a `Grep` or `Glob` call. So a search of a folder can find a protected file in it. Claude Code applies the `Read` deny rules to `Grep` and `Glob` as a best effort.

The hook reads a shell command as a word list, not with a parser. It reads the words again without quotes, backslashes and line continuations, so `cat .e''nv` and `cat .e$'n'v` are refused like `cat .env`. Other shell expansions can still hide a path, such as a variable, an escape code `$'\x2e'`, a command substitution, a glob or a brace list. A quoted path with a space, a `name=value` word such as `if=.env`, another user's `~name` or another program can hide a path too.

## Limits that are specific to Claude Code

The limits that apply to each agent are in [What lmsk does not protect](GUIDE.md#what-lmsk-does-not-protect).

- **There is no `/lmsk` command.** You cannot see the status, reveal a fake or stop masking from Claude Code. On macOS, the service writes its messages to `serve.log` in the vault folder. On Linux, run `journalctl --user -u lmsk.service`.
- **Thinking text keeps its fakes.** Anthropic rejects a changed thinking block. So the proxy gives thinking back as it came.
- **A value can keep its fake in a reply.** The proxy puts back a value of 8 characters or more, and each value of a `literal` or `env` rule. It does not put back a value that the model glues to a letter, a digit or `_`. A later request cannot always mask a glued value.
- **A reply that is not streamed keeps its fakes.** The proxy puts back real values only in streamed replies.
- **An `env` rule does not see your terminal.** See [Your configuration file](#your-configuration-file).
- **A hidden copy can reach Anthropic before `lmsk` learns the secret.** The proxy withholds a text that holds a known secret spaced out, wrapped, reversed or encoded. The requests before `lmsk` learned the secret already sent the text.
- **Do not use lmsk for Claude Code on a computer that other people log in to.** The proxy uses the fixed port 25675. When the proxy does not run, another user can open this port. Then that user gets your requests, with real values and your API key.
- **The proxy knows a tool only by its name.** A tool with the name of a built-in tool gets real values too.
- **The request path and query are not masked.** The proxy masks only the request body and headers.
- **A header that hides a secret can make Anthropic refuse the request.** The proxy sends the withheld text in place of such a header value.
- **Tools that run at Anthropic see fakes.** A web search that Anthropic runs uses the masked text.
- **Telemetry goes past the proxy.** Claude Code sends its telemetry to Anthropic directly, not through the proxy. If you turn on OpenTelemetry content export, such as `OTEL_LOG_USER_PROMPTS`, it can send real values.
- **The vault is in `~/.local/state/lmsk/`.** If `XDG_STATE_HOME` was set when you ran `lmsk install claude`, it is in `lmsk/` in that folder. pi uses the same vault. It is not encrypted. Exclude it from cloud backups.

## Uninstall

1. Stop the service and remove its file.

   On macOS:

   ```bash
   launchctl bootout gui/$(id -u)/io.github.hugolopes45.lmsk
   rm ~/Library/LaunchAgents/io.github.hugolopes45.lmsk.plist
   ```

   On Linux:

   ```bash
   systemctl --user disable --now lmsk.service
   rm ~/.config/systemd/user/lmsk.service
   systemctl --user daemon-reload
   ```

2. Open `~/.claude/settings.json` and remove the keys that `lmsk install claude` added. See [What lmsk install claude changes](#what-lmsk-install-claude-changes). The hook is the `PreToolUse` group whose `args` end with `hook` and `claude`.
3. If you use a gateway, set `ANTHROPIC_BASE_URL` again to the address in the file `upstream` in the vault folder.
4. Run `npm uninstall -g @hugolopes45/lmsk`.
5. If you do not use lmsk with pi, delete the vault folder. It holds the real values next to their fakes. If you do not need your rules, delete the folder of [your configuration file](#your-configuration-file) too.
6. Close each Claude Code session that runs, then start it again.
