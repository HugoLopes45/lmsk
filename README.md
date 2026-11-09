<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img src="docs/brand/logo.svg" alt="lmsk" width="320">
  </picture>
</h1>

## Real keys for your agent. Fakes for the model.

`lmsk` swaps API keys, passwords, tokens and emails for fakes before Claude Code or pi sends a request to the LLM provider. Tool calls get the real values back, so your commands still run.

[Website](https://hugolopes45.github.io/lmsk/) &nbsp;·&nbsp; [Install](#install) &nbsp;·&nbsp; [Agents](#agents) &nbsp;·&nbsp; [FAQ](#faq) &nbsp;·&nbsp; [Good to know](#good-to-know)

[![CI](https://github.com/HugoLopes45/lmsk/actions/workflows/ci.yml/badge.svg)](https://github.com/HugoLopes45/lmsk/actions/workflows/ci.yml)
![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20pi-6d28d9)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

<a id="install"></a>
<a id="agents"></a>

Pick your agent. One line each.

**Claude Code**

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

The default rules work with no configuration. Local only: no model, no account, no telemetry.

---

## You know this moment

- The agent read your `.env` to debug a config problem, and your API key went to the model provider in the next request.
- A log line held a customer email, and the agent put that log in its context.
- A stack trace printed a bearer token, and the token was sent with the rest of the output.

Your coding agent sends what it reads to the model provider. That includes your secrets.

## What lmsk handles

| You | What lmsk does |
|---|---|
| You paste a Stripe key so that the agent can set up payments. | The model gets a fake. The file that the agent writes gets the real key. |
| The agent tries to open `.env` to debug a config problem. | `lmsk` refuses the read and tells the agent why. |
| A command prints `DATABASE_URL` with its password. | The model gets the URL with a fake password. |
| The agent runs your tests, which need the real password. | The test command gets the real password. Its output goes back to the model masked. |
| A log holds customer emails, phone numbers and card numbers. | The model gets fakes. |
| You work for a client under NDA. | Add the client name once. The model gets a name such as `Client 1`. |
| Your file paths and commits show your name and your computer. | The model gets fakes for your user name, host name and git identity. |

The [user guide](docs/GUIDE.md) shows how to add your client names and your own secrets.

## How it works

1. **Install it once.** `lmsk` runs on your computer, as a local proxy in front of your agent or as an extension inside it.
2. **Each request is masked on your computer.** `lmsk` searches the whole request with 280 rules. It replaces each secret with a fake of the same length and keeps the real value in a vault on your computer.
3. **Tool calls get the real values back.** When the agent writes a file or runs a command with a fake, `lmsk` puts the real value back. The command runs with your real secret. In the replies, you see the fakes.

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

**How do I hide a value that has no known format?**
Add a rule for it. Detection uses patterns, so give a rule to each short password that has no key name, such as `summer2024`, and to names of people and postal addresses. `lmsk` also blocks the usual agent reads of `.env`, keys and other secret files. See [Add your own secrets](docs/GUIDE.md#add-your-own-secrets).

**Does it slow requests?**
A little. In our test, masking a 20 kB tool result took about 17 ms (median of 30 runs, Apple M1 Max). A search that takes more than 5 seconds cancels the request.

**Where are the real values stored?**
In the local vault on your computer, a plain JSON file that only your user account can read. Keep it out of cloud backups.

**How do I stop Claude Code from sending my API keys and .env values to the model?**
Run Claude Code with `lmsk claude`. `lmsk` masks the secrets in each request before it leaves your computer, also in the text that you paste and in command output. It also refuses the tool calls that open `.env`, keys and other secret files. A `Read` deny rule in the Claude Code settings stops a file read, but it does not mask what you paste or what a command prints. In pi, install the extension.

**How is it different from gitleaks or a redaction hook?**
gitleaks finds secrets in files and commits, so that you can remove them. `lmsk` uses the gitleaks default rules, and its own rules, on each request that the agent sends. A hook that replaces a secret with `[REDACTED]` gives that tag to your commands. `lmsk` gives a fake of the same length to the model, and the real value to the tool calls.

**Which agents does it work with?**
Claude Code and pi. [Install](#install) shows the command for each one.

## Good to know

- **Replies show fakes.** Tool calls get the real values. In pi, `/lmsk reveal` shows the real values of a reply.
- **Your code goes to the model as usual.** `lmsk` hides secrets, personal data and IDs.
- **Pair it with a sandbox.** Shell commands get the real values that they need, and network access stays as your agent has it.
- **A fake has the length of its value.**
- **Your agent keeps its own local history.** For example, Claude Code keeps it in `~/.claude/projects/` on your computer.
- **Configuration and storage can change before 1.0.** Try it on your own data first.

The full list is in the guide: [What lmsk does not protect](docs/GUIDE.md#what-lmsk-does-not-protect).

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
