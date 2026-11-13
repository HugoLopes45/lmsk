<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img src="docs/brand/logo-readme.svg" alt="lmsk" width="320">
  </picture>
</h1>

## Real keys for your agent. Fakes for the model.

`lmsk` replaces detected API keys, passwords, tokens and emails with fakes before your AI coding agent sends a request to the model. Only the request changes: you read the real values in replies, and supported file and shell tools get the original values back. Keep useful context in your coding workflow, with masking handled on your computer.

[Website](https://hugolopes45.github.io/lmsk/) &nbsp;·&nbsp; [Install](#install) &nbsp;·&nbsp; [Agents](#agents) &nbsp;·&nbsp; [FAQ](#faq) &nbsp;·&nbsp; [Good to know](#good-to-know)

[![CI](https://github.com/HugoLopes45/lmsk/actions/workflows/ci.yml/badge.svg)](https://github.com/HugoLopes45/lmsk/actions/workflows/ci.yml)
![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20pi-6d28d9)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

<a id="install"></a>
<a id="agents"></a>

Choose your agent and follow its commands.

**Claude Code**

```bash
npm install -g @hugolopes45/lmsk
lmsk install claude
```

Requires macOS or Linux, Node.js 22.19+ and Claude Code 2.1.295+. Restart your Claude Code sessions, then use `claude` as usual. Setup and compatibility: [Claude Code guide](docs/claude-code.md).

**pi**

```bash
pi install npm:@hugolopes45/lmsk
```

Then start pi, or type `/reload` in an open pi. Guide: [lmsk with pi](docs/pi.md).

The default rules work with no configuration. Local only: no model, no account, no telemetry.

---

## Keep the context. Mask the secrets.

Debug from logs, configure your app and run tests with your coding agent. lmsk replaces the sensitive values it detects while preserving the surrounding text.

| Your workflow | What lmsk adds |
|---|---|
| Debug from application logs. | Detected keys, emails and tokens become fakes; the surrounding error stays readable. |
| Write a configuration file with a detected API key. | Supported file tools restore the original key when the model uses its fake. |
| Run a local test with a masked password. | Supported shell calls restore the password, then mask detected secrets in the output. |
| Work with client names or project names. | Add a custom rule to replace a name with a label such as `Client 1`. |

The [user guide](docs/GUIDE.md) shows how to tailor masking to your project.

## How it works

1. **Run locally.** lmsk works as a local proxy service in front of Claude Code, or as an extension inside pi.
2. **Mask detected values.** Built-in rules scan request text and replace matching values with fakes. A local vault keeps the mapping.
3. **Restore values for you and your tools.** lmsk puts the original values back into the replies that you read. When a supported tool call uses an exact fake, lmsk restores its original value before execution. See [tool behavior and compatibility](docs/GUIDE.md#what-lmsk-does-not-protect).

## See the transformation

### A request body, before and after

This example shows a tool result from `docker compose logs api --tail 3`. All values below are illustrative:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01A",
  "content": "api-1  | config OPENAI_API_KEY=sk-proj-4fQ9xT2mLp8VnR3kWc7ZsB1yHd6JeA0uGt5\napi-1  | refund failed for customer jane.doe@example.com\napi-1  |     at charge (billing.ts:42) Authorization: Bearer 7Hq2Lx9VmK4pR8sT1wZ6cN3bY5dF0gJ"
}
```

Here is the masked version of that block. The surrounding log stays readable. Each computer makes its own fakes, and a value gets the same fake in each session on that computer:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01A",
  "content": "api-1  | config OPENAI_API_KEY=T8MCnGhey7vwndvjsQBbNPVIDZBUtkj80LcGEhqcWCr\napi-1  | refund failed for customer bmib.xtm@kitquhs.mnn\napi-1  |     at charge (billing.ts:42) Authorization: Bearer IA1uy6fuqU2b89b3k4zir4UPE9BL7Q1"
}
```

The key, the email and the token are fakes. The rest of the text did not change, so the model can still read the error.

### Checked before sending

lmsk completes its masking checks before forwarding a request. If a check fails or times out, the request stops. [Troubleshooting](docs/TROUBLESHOOTING.md) explains each status and the next step.

### 280 detection rules

- 217 vendor key formats from the [gitleaks](https://github.com/gitleaks/gitleaks) rules.
- 47 rules for more key formats, keyed secrets such as `password: ...`, and credentials in URLs and headers.
- 1 rule for secret variable names. The value of `DB_PASSWORD` or `GITHUB_TOKEN` is hidden, also when its format is unknown.
- 12 rules for personal data: emails, phone numbers, IBANs, payment cards, national ID numbers, UUIDs, and IP and MAC addresses.
- 3 rules for IDs, such as values under keys such as `userId`.
- Each agent also adds one rule that hides your user name, host name and git identity.

You can add your own rules, for example to turn `Falcon Industries` into `Client 1`. See [Hide who you work for](docs/GUIDE.md#hide-who-you-work-for). The full list is in [What the default rules detect](docs/CONFIGURATION.md#what-the-default-rules-detect).

### A local vault

The mapping stays in one local vault for each computer, `~/.local/state/lmsk/vault.jsonl`, with owner-only file permissions. lmsk does not upload it. See [vault storage and backup guidance](docs/GUIDE.md#what-lmsk-does-not-protect).

### Try it with a sample key

Send this message to your agent. The key in it is a test value:

```text
Spell the value after API_KEY= with a space between each character: API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc
```

The reply spells the fake that the model received, so it does not start with `Z q 7 K p 2`. lmsk puts back only whole fakes, so a spelled fake stays visible. Use [Troubleshooting](docs/TROUBLESHOOTING.md) to check your setup if the reply spells the original value.

## FAQ

**Which agents does it work with?**
Claude Code and pi. [Install](#install) has a separate setup path for each agent.

**How does my agent use the original values?**
lmsk restores exact fakes in supported file and shell tool calls. For commands that access the network, supply credentials through the environment. See [tool behavior and compatibility](docs/GUIDE.md#what-lmsk-does-not-protect).

**Do I see fakes in replies?**
No. lmsk puts the real values back into the replies that you read. Thinking text and some short or glued values keep their fakes. See the [Claude Code guide](docs/claude-code.md#use-it-every-day) and the [pi guide](docs/pi.md#use-it-every-day).

**Can I add client names and custom values?**
Yes. Add a rule for the value you want to mask, including names, addresses and project-specific secrets. See [Add your own secrets](docs/GUIDE.md#add-your-own-secrets).

**How does it work with gitleaks?**
gitleaks scans files and commits. lmsk uses its detection rules, alongside additional rules, to mask matching values in requests to the model.

**Is it free?**
Yes. lmsk is open source under the MIT license. No account or telemetry.

## Good to know

Start with the built-in rules, then add project-specific values. The [coverage, tool compatibility and storage guide](docs/GUIDE.md#what-lmsk-does-not-protect) explains how to choose the right setup. Agent-specific behavior is documented in the [Claude Code guide](docs/claude-code.md) and [pi guide](docs/pi.md).

## Privacy

`lmsk` uses no model. It has no account and no telemetry. An extension inside the agent makes no network connections. The local proxy connects only to the provider address of the agent.

## Start now

[Choose your agent](#install), install lmsk, then try the sample key above.

## Use it in your own agent

The package also exports the engine that the Claude Code and pi integrations use. Open a `Guard` and mask each text before you send it. Restore each reply with `guard.textRestorer()`, and each tool call before you run it with `guard.restoreCall(call)`. Do not run a call when `restoreCall` returns `blocked: true`. For a shell tool, set `commandKey` to the key of its command, so that a network command keeps its fakes.

```ts
import { homedir } from "node:os";
import { Guard, localIdentityRules, machinePaths } from "@hugolopes45/lmsk";

const guard = new Guard({
  name: "my-agent",
  tools: ["shell"],
  protectedPaths: ["**/.env"],
  format: { opaque: () => false },
});
guard.open(
  () => ({
    configPaths: [],
    projectConfigPath: undefined,
    stateDir: machinePaths(process.env, homedir()).stateDir,
    env: process.env,
    defaultRules: localIdentityRules(),
  }),
  { ui: { notify: (message) => console.error(message) }, abort() {} },
);
const masked = await guard.maskText("API_KEY=Zq7Kp2Lm9Xw4Rt8Vb3Nc");
console.log(masked);
const restorer = guard.textRestorer();
console.log(restorer.push(masked) + restorer.end());
guard.close();
```

The vault in `stateDir` keeps the fakes, so a resumed conversation gets the same fakes.

## Documentation

- [lmsk with Claude Code](docs/claude-code.md): install, daily use, what `lmsk install claude` changes.
- [lmsk with pi](docs/pi.md): install, daily use, `/lmsk` commands.
- [User guide](docs/GUIDE.md): add your own secrets and hide client names.
- [Configuration](docs/CONFIGURATION.md): every setting, rule type and default rule.
- [Troubleshooting](docs/TROUBLESHOOTING.md): each error code and what to do.
- [Changelog](CHANGELOG.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems as described in [SECURITY.md](SECURITY.md). Never report them in a public issue.

## License

[MIT](LICENSE). The vendor key rules come from [gitleaks](https://github.com/gitleaks/gitleaks), MIT License, Copyright (c) 2019 Zachary Rice.
