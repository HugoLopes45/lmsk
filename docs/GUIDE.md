# lmsk user guide

`lmsk` (LLM mask) replaces your secrets with fakes before your coding agent sends a request to the model provider. When the agent uses a fake in a built-in tool, `lmsk` puts the real value back. Everything runs on your computer.

`lmsk` is not a sandbox. It hides values, not your code. Read [What lmsk does not protect](#what-lmsk-does-not-protect) before you use it on real data.

## Start here

1. Install `lmsk` and check that it works. Follow the page of your agent: [lmsk with pi](pi.md) or [lmsk with Claude Code](claude-code.md).
2. [Add your own secrets](#add-your-own-secrets) and [hide who you work for](#hide-who-you-work-for).
3. Read [Before you use it on a client project](#before-you-use-it-on-a-client-project).

This guide applies to each agent. When a step is different for an agent, the guide tells you.

## Words used in this guide

| Word | Meaning |
|---|---|
| Model provider | The company that runs the AI model, for example Anthropic, OpenAI or Google. |
| Request | One message that your agent sends to the model provider. It holds the conversation so far. |
| Fake | A random value that the extension puts in place of a real value. |
| Vault | A file on your computer that keeps each real value next to its fake. |
| Rule | An instruction that tells the extension what to find and how to replace it. |
| Session | One conversation with your agent. |
| Tool | An action that the agent can do, for example `read` a file, `write` a file or run a `bash` command. |
| Context file | A file that your agent reads when a session starts, such as `AGENTS.md` or `CLAUDE.md`. |

## Your configuration file

| Agent | Configuration file | After you change it |
|---|---|---|
| pi | `~/.pi/agent/lmsk/config.json` (Windows: `%USERPROFILE%\.pi\agent\lmsk\config.json`) | Type `/reload` in pi. |
| Claude Code | `~/.config/lmsk/config.json` | Close Claude Code and start it again with `lmsk claude`. |

The file is a text file in JSON format. The extension uses it in all projects. Both files have the same format. The steps below say "apply the change" for the last column.

## Add your own secrets

The default rules find values that have a known format. They also hide the value of a variable whose name holds a secret word, such as `DB_PASSWORD` or `GITHUB_TOKEN`, when the value has 8 or more characters and is not only digits. Add a rule for other values, for example a client name, a short password or a password of digits only.

1. Create the configuration file of your agent.

   On macOS or Linux, run one of these commands in a terminal. The `~` sign is your home folder.

   ```bash
   mkdir -p ~/.pi/agent/lmsk && nano ~/.pi/agent/lmsk/config.json    # pi
   mkdir -p ~/.config/lmsk && nano ~/.config/lmsk/config.json        # Claude Code
   ```

   On Windows with pi, run these commands in the Command Prompt:

   ```bat
   mkdir %USERPROFILE%\.pi\agent\lmsk
   notepad %USERPROFILE%\.pi\agent\lmsk\config.json
   ```

   If the folder already exists, `mkdir` shows an error. You can ignore it.

   Use a plain text editor, such as nano or Notepad. Do not use Word or another rich text editor, because its curly quotes make the file invalid.

2. Put this text in the file. Change `DB_PASSWORD` to the name of your variable:

   ```json
   {
     "rules": [
       { "id": "my-passwords", "type": "env", "vars": ["DB_PASSWORD"] }
     ]
   }
   ```

   Do not leave a comma after the last rule. In nano, save with Ctrl+O and Enter, then close with Ctrl+X.

3. Apply the change. See [Your configuration file](#your-configuration-file).
4. To check, ask your agent: `Run printenv DB_PASSWORD and show me the output.` The reply must not show your password.

An `env` rule hides the value of each environment variable in `vars`. An environment variable is a named value that your terminal gives to the programs that it starts. Use this rule for passwords, so that the configuration file does not contain them.

The rule reads the variable only from the terminal that starts your agent, when the session starts. It does not read a `.env` file. To check on macOS or Linux, run this command in that terminal before you start your agent. It must show `set`:

```bash
printenv DB_PASSWORD > /dev/null && echo set || echo missing
```

A new rule protects only the requests after you apply the change. The model provider already has what your agent sent before. For a clean start, start a new session.

To turn off a default rule, such as the email rule, see [How the levels combine](CONFIGURATION.md#how-the-levels-combine). All settings, rule types and options are in [docs/CONFIGURATION.md](CONFIGURATION.md).

## Hide who you work for

The model can do your work without the name of your employer or your client. Put a `literal` rule in the global configuration file, so that the name stays out of the repository. A `literal` rule hides the exact texts in `values`:

```json
{
  "id": "client",
  "type": "literal",
  "values": ["Falcon Industries", "FALCON INDUSTRIES", "Falcon", "falcon-industries.com"],
  "strategy": "fixed",
  "replacement": "Client{n}"
}
```

Change the values to the names of your client. This is one rule, not a whole file. If the file already has a `rules` list, copy the rule, from `{` to `}`, into that list. Put a comma between two rules. [Put several rules in one file](#put-several-rules-in-one-file) shows a complete file.

The `fixed` strategy replaces each text with `Client` and a number, for example `Client 1` for `Falcon Industries`. A replacement can keep useful context, for example `EnergyCompany{n}`.

- Upper and lower case must match. Write each spelling that can occur: upper case, short name, web domain. Spellings that differ only in case or in the signs between letters share one number, and each fake keeps the case and the sign of its spelling: `Falcon Industries` becomes `Client 1` and `FALCON INDUSTRIES` becomes `CLIENT 1`. Another name, such as the short name `Falcon`, gets the next number.
- A text matches only as a whole word. So `Falcon` does not match in `Falcons`.
- Built-in tools get the real name back. `Client 1` in a file that the agent writes becomes `Falcon Industries` on disk.
- The domain in an email such as `jane@falcon-industries.com` is hidden too.
- The file keeps these texts in clear, so do not put a password in a `literal` rule.
- The model can still guess the name from other words, such as site names, product names, colleague names, stock tickers, domains and email signatures. Add each of them to the same `values` list.

To check, apply the change, then send: `Repeat exactly: Falcon Industries`. The reply must show `Client` and a number, such as `Client 1`.

To match many spellings with one pattern, use a `regex` rule. See the [employer example](CONFIGURATION.md#regex).

## Put several rules in one file

This global configuration file holds three rules: the password rule, the client rule, and an entry that turns off the default `email` rule.

```json
{
  "rules": [
    { "id": "my-passwords", "type": "env", "vars": ["DB_PASSWORD"] },
    {
      "id": "client",
      "type": "literal",
      "values": ["Falcon Industries", "FALCON INDUSTRIES", "Falcon", "falcon-industries.com"],
      "strategy": "fixed",
      "replacement": "Client{n}"
    },
    { "id": "email", "enabled": false }
  ]
}
```

To add a rule to an existing `rules` list:

1. Copy only the rule, from `{` to `}`.
2. Paste it in the list, between `[` and `]`.
3. Put a comma between two rules. Do not put a comma after the last rule.

Do not add a second `{ "rules": ... }` block to the file. The file is then invalid, and the extension blocks every request that needs masking with `CONFIG_INVALID`.

With the `email` rule off, emails reach the model provider in clear. Read [How the levels combine](CONFIGURATION.md#how-the-levels-combine) before you turn it off.

## Before you use it on a client project

1. Ask your client if its code may go to the model provider. The extension hides secrets, not the code.
2. Add the client name and its other names. See [Hide who you work for](#hide-who-you-work-for).
3. Do the check on the page of your agent ([pi](pi.md#check-that-it-works) or [Claude Code](claude-code.md#check-that-it-works)), with one line from the project.
4. With pi, never type `/lmsk off` in the client project. With Claude Code, never start `claude` without `lmsk`.
5. This is version 0.1. Get the approval of the security contact of the client.

The full list of limits follows.

## What lmsk does not protect

Read these limits before you trust the extension with real data. The most important limits come first.

- **It is not a sandbox.** A sandbox stops a program from reaching the network or your files. This extension does not stop a tool from sending data to the network. A `bash` command that names a network program, such as `curl` or `git push`, gets fakes, not real values. If such a command needs a real secret, it must read the secret from the environment. The extension does not protect you from other extensions, from tools that send data themselves, or from a compromised computer.
- **The vault file is not encrypted.** The vault is plain JSON, in `~/.pi/agent/lmsk-vaults/` with pi and in `~/.local/state/lmsk/vaults/` with Claude Code. Only your user account can read it (file mode 0600, folder mode 0700). But other programs that run as your user, an administrator (root), backups and disk snapshots can read the real values in it. If your backups go to a cloud service, exclude the vault folder from them.
- **A model can change a value before it uses it.** For example, it can split the value, encode it twice, or take its last characters. The extension puts back only exact fakes, also when they are encoded once. A changed fake stays a fake in your files, and you get no warning.
- **Detection uses patterns.** A secret with no known format and no key name is not found, for example a short or simple password. So `summer2024` alone in a text is not found, but `password: summer2024` is. Names of people and postal addresses are not found. Add a `literal` or `env` rule for such a value.
- **Employer names, code names and project names are not found.** The extension cannot guess them in paths, host names or files. A path such as `/Users/<user>/Clients/<employer>/` still shows the employer after the user name is masked. List each name as in [Hide who you work for](#hide-who-you-work-for).
- **Protected paths check only one argument.** The extension refuses `read`, `grep`, `find` and `ls` on a protected path, such as `.env`, and on a link to it. But `grep` or `find` on a whole folder, or a `bash` command, can still read a protected file. The masking rules still apply to that output.
- **The `bash` tool gets real values.** Its output is masked, and the real values that the command received are masked in it too, also when they are encoded once. A command that encodes a value twice, or splits it, can send it to the model provider.
- **Some hidden copies pass.** Output that spells a value with spaces, such as `od -c`, is withheld only when the vault already holds the value. So `od -c` on a file that the model has not read yet sends its values.
- **Numbers in tool results are not masked.** The extension masks text only. A secret that a tool returns as a number stays visible.
- **Images and signed data pass unchanged.** A secret in an image, a data URL, a signed or encrypted field, or a signed thinking block reaches the model provider. The extension does not search them, and image data does not count toward the 8 MiB request limit, so an image never blocks a request. A change to signed data would break the provider check. A signed text block or tool call that masking would change is withheld instead.
- **Google models can fail.** The extension treats a Google `thoughtSignature` as ordinary text. A rule that matches it can change it, and the provider can then refuse the conversation.
- **Some provider error text is lost.** If masking would change how pi reacts to a provider error, the extension saves a fixed text instead, for example `503 provider error, text withheld`. The rest of the error text is not saved.
- **A very long conversation can block every request.** The extension checks the whole conversation on each request. Above about 5 MB of history (an estimate), the check can take longer than `scanTimeoutMs`. Then every request is blocked. Start a new session with `/new`.
- **Your user name, host name and git identity are masked only in the same case.** The `local-identity` rule masks them in each request. Upper and lower case must match, so `JOHN SMITH` passes when git has `John Smith`. Details and limits are in [Local identity](CONFIGURATION.md#local-identity).

Each agent has more limits. Read [Limits that are specific to pi](pi.md#limits-that-are-specific-to-pi) and [Limits that are specific to Claude Code](claude-code.md#limits-that-are-specific-to-claude-code).
