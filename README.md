<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img src="docs/brand/logo.svg" alt="lmsk" width="320">
  </picture>
</h1>

## Real keys for your agent. Fakes for the model.

`lmsk` swaps API keys, passwords, tokens and emails for fakes before Claude Code or pi sends a request to the LLM provider. Tool calls get the real values back, so your commands still run.

[Website](https://hugolopes45.github.io/lmsk/) &nbsp;·&nbsp; [Install](#install) &nbsp;·&nbsp; [Agents](#agents) &nbsp;·&nbsp; [FAQ](#faq) &nbsp;·&nbsp; [Limits](#limits)

[![CI](https://github.com/HugoLopes45/lmsk/actions/workflows/ci.yml/badge.svg)](https://github.com/HugoLopes45/lmsk/actions/workflows/ci.yml)
![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20pi-6d28d9)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

<a id="install"></a>
<a id="agents"></a>

Pick your agent. One line each.

**Claude Code (preview)**

```bash
npm install -g @hugolopes45/lmsk
lmsk claude
```

Use `lmsk claude` in place of `claude`. Guide: [lmsk with Claude Code](docs/claude-code.md).

**pi**

```bash
pi install npm:@hugolopes45/lmsk
```

Then start pi, or type `/reload` in an open pi. Guide: [lmsk with pi](docs/pi.md).

More agents are planned. The default rules work with no configuration. Local only: no model, no account, no telemetry.

---

## You know this moment

- The agent read your `.env` to debug a config problem, and your API key went to the model provider in the next request.
- A log line held a customer email, and the agent put that log in its context.
- A stack trace printed a bearer token, and the token was sent with the rest of the output.

Your coding agent sends what it reads to the model provider. That includes your secrets.

## How it works

1. **Install it once.** `lmsk` runs on your computer, as a local proxy in front of your agent or as an extension inside it.
2. **Each request is masked on your computer.** `lmsk` searches the whole request with 280 rules. It replaces each secret with a fake of the same length and keeps the real value in a vault on your computer.
3. **Tool calls get the real values back.** When the agent writes a file or runs a command with a fake, `lmsk` puts the real value back. The command runs with your real secret. The replies that you read can show fakes.

## Proof

### A real request body, before and after

The agent ran `docker compose logs api --tail 3`. This is the tool result in the request that the agent prepared:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01A",
  "content": "api-1  | config OPENAI_API_KEY=sk-proj-4fQ9xT2mLp8VnR3kWc7ZsB1yHd6JeA0uGt5\napi-1  | refund failed for customer jane.doe@example.com\napi-1  |     at charge (billing.ts:42) Authorization: Bearer 7Hq2Lx9VmK4pR8sT1wZ6cN3bY5dF0gJ"
}
```

This is the same block after `lmsk` masked it. The model provider receives this version. The fakes are random, so yours are different:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01A",
  "content": "api-1  | config OPENAI_API_KEY=T8MCnGhey7vwndvjsQBbNPVIDZBUtkj80LcGEhqcWCr\napi-1  | refund failed for customer bmib.xtm@kitquhs.mnn\napi-1  |     at charge (billing.ts:42) Authorization: Bearer IA1uy6fuqU2b89b3k4zir4UPE9BL7Q1"
}
```

The key, the email and the token are fakes. The rest of the text did not change, so the model can still read the error.

### It fails closed

If `lmsk` cannot mask a request safely, it cancels the request. It never sends a partly masked request. You see an error such as:

```text
lmsk: SCAN_TIMEOUT. The request was stopped. Masking stays on.
```

Each error code and its fix is in [Troubleshooting](docs/TROUBLESHOOTING.md).

### 280 detection rules

- 217 vendor key formats from the [gitleaks](https://github.com/gitleaks/gitleaks) rules.
- 47 rules for more key formats, keyed secrets such as `password: ...`, and credentials in URLs and headers.
- 1 rule for secret variable names. The value of `DB_PASSWORD` or `GITHUB_TOKEN` is hidden, also when its format is unknown.
- 12 rules for personal data: emails, phone numbers, IBANs, payment cards, national ID numbers, UUIDs, and IP and MAC addresses.
- 3 rules for IDs, such as values under keys such as `userId`.
- Each agent also adds one rule that hides your user name, host name and git identity.

You can add your own rules, for example to turn `Falcon Industries` into `Client 1`. See [Hide who you work for](docs/GUIDE.md#hide-who-you-work-for). The full list is in [What the default rules detect](docs/CONFIGURATION.md#what-the-default-rules-detect).

### A local vault

The real values stay in a JSON file on your computer that only your user account can read. The guide of each agent gives its path. `lmsk` sends the vault nowhere.

### Check it yourself in one minute

Send this message to your agent. The key in it is a test value:

```text
Repeat this line exactly: API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc
```

The reply must show a different value after `API_KEY=`. That value is the fake that the provider received.

## FAQ

**Does it break my commands?**
No. When a tool call holds a fake, `lmsk` puts the real value back before the tool runs. This applies to the built-in file and shell tools of your agent. Other tools, such as MCP tools, get fakes.

**What if detection misses something?**
Then that value goes to the provider. Detection uses patterns. A short password with no key name, such as `summer2024` alone in a text, is not found. Names of people and postal addresses are not found. Add a rule for each value that you must hide. Also, `lmsk` blocks the usual agent reads of `.env`, keys and other secret files.

**Does it slow requests?**
A little. In our test, masking a 20 kB tool result took about 17 ms (median of 30 runs, Apple M1 Max). A search that takes more than 5 seconds cancels the request.

**Where are the real values stored?**
In the local vault on your computer, a JSON file that only your user account can read. It is not encrypted. Exclude it from cloud backups.

**How do I stop Claude Code from sending my API keys and .env values to the model?**
Run Claude Code with `lmsk claude`. `lmsk` masks the secrets in each request before it leaves your computer, also in the text that you paste and in command output. It also refuses the tool calls that open `.env`, keys and other secret files. A `Read` deny rule in the Claude Code settings stops a file read, but it does not mask what you paste or what a command prints. In pi, install the extension.

**How is it different from gitleaks or a redaction hook?**
gitleaks finds secrets in files and commits, so that you can remove them. `lmsk` uses the gitleaks default rules, and its own rules, on each request that the agent sends. A hook that replaces a secret with `[REDACTED]` gives that tag to your commands. `lmsk` gives a fake of the same length to the model, and the real value to the tool calls.

**Which agents does it work with?**
Claude Code (preview) and pi today. More agents are planned. [Install](#install) shows the command for each one.

## Limits

- **A reply can show fakes.** `lmsk` puts real values back only into tool calls. In pi, `/lmsk reveal` shows the real values.
- **Your code still goes to the model provider.** `lmsk` hides secrets, personal data and IDs, not your code.
- **It is not a sandbox.** A shell command gets the real values it needs, and `lmsk` does not stop a tool from using the network. Use a sandbox as well.
- **A fake shows the length of its value.** The model provider learns the length of each password and token.
- **Your agent can keep its own history.** Claude Code, for example, keeps the real values in `~/.claude/projects/` on your computer.
- **This is an early version.** Configuration and storage can change before 1.0. Test it on your own data before you trust it.

Read the full list before you use `lmsk` on real data: [What lmsk does not protect](docs/GUIDE.md#what-lmsk-does-not-protect).

## Privacy

`lmsk` uses no model. It has no account and no telemetry. An extension inside the agent makes no network connections. The local proxy connects only to the provider address of the agent.

## Start now

Pick your agent in [Install](#install) and run its line.

## Documentation

- [lmsk with Claude Code](docs/claude-code.md): install, daily use, what `lmsk claude` changes.
- [lmsk with pi](docs/pi.md): install, daily use, `/lmsk` commands.
- [User guide](docs/GUIDE.md): add your own secrets and hide client names.
- [Configuration](docs/CONFIGURATION.md): every setting, rule type and default rule.
- [Troubleshooting](docs/TROUBLESHOOTING.md): each error code and what to do.
- [Changelog](CHANGELOG.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems as described in [SECURITY.md](SECURITY.md). Never report them in a public issue.

## License

[MIT](LICENSE). The vendor key rules come from [gitleaks](https://github.com/gitleaks/gitleaks), MIT License, Copyright (c) 2019 Zachary Rice.
