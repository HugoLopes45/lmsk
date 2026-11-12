# Configuration

The default rules work with no configuration file. This page tells you how to add rules, change the defaults and change the settings.

Words used on this page:

| Word | Meaning |
|---|---|
| Rule | An instruction that tells the extension what to find and how to replace it. Each rule has an `id`. |
| Fake | A random value that the extension puts in place of a real value. |
| Strategy | The way a rule makes its fake. |
| Regex | A text pattern that can match many texts, for example `\d{4}` for four digits. In a JSON file, write each `\` twice: `\\d{4}`. |
| Glob | A path pattern, for example `**/.env*` for each file, in any folder, whose name starts with `.env`. |
| Environment variable | A named value that your terminal gives to the programs that it starts, for example `DB_PASSWORD`. |

## Where the files are

You can use one file, two files, or none.

| Level | Path | When the extension reads it |
|---|---|---|
| Global | `~/.pi/agent/lmsk/config.json` (Windows: `%USERPROFILE%\.pi\agent\lmsk\config.json`) | Always. |
| Project | `<project>/.pi/lmsk.json` | Only when you trust the project in pi. |

If you set the `PI_CODING_AGENT_DIR` environment variable, the global file is `lmsk/config.json` in that folder.

The proxy for Claude Code reads only its own global file, `~/.config/lmsk/config.json` (or `lmsk/config.json` in `XDG_CONFIG_HOME`), and no project file. The other differences are in [lmsk with Claude Code](claude-code.md#your-configuration-file).

The extension reads the files when a session starts. After you change a file, type `/reload` in pi.

## How the levels combine

1. The extension starts with the default rules and settings.
2. It applies the global file.
3. It applies the project file, if the project is trusted.

Rules combine by `id`. A rule with a new `id` is added. A rule with an existing `id` changes only the fields that you give. For example, this rule turns off the default `email` rule:

```json
{ "rules": [{ "id": "email", "enabled": false }] }
```

- Put this in the global file. In a project file, it blocks every request that needs masking.
- If the file already has a `rules` list, copy only the entry, from `{` to `}`, into that list. Put a comma between two entries. The user guide shows [a complete file](GUIDE.md#put-several-rules-in-one-file).
- Emails that were already replaced in this session stay replaced. Start a new session with `/new` to see all emails in clear.
- Your own git email stays hidden by the `local-identity` rule. All other emails then reach the model provider in clear.

In a list setting, such as `protectedPaths`, your items are added to the default items. An item that starts with `!` removes a default item. For example, `"!**/*.tfvars"` removes the `**/*.tfvars` glob.

## What a project file can do

A project file can only add:

- rules with a new `id`,
- items in `protectedPaths`,
- items in `networkCommands`.

A project file cannot change a default rule or a global rule, remove an item with `!`, or set any other setting. If it tries, the configuration is invalid and the extension blocks every request that needs masking. Put these changes in the global file. If the project file is in the repository, other people can read it. Do not put secrets or employer names in it.

## Example

This example is a global file. Its `email` entry and its `!` glob are not allowed in a project file.

```json
{
  "rules": [
    {
      "id": "client-names",
      "type": "env",
      "vars": ["CLIENT_NAME", "CLIENT_CODE"]
    },
    {
      "id": "ticket-id",
      "type": "regex",
      "pattern": "\\bTICKET-(\\d{4,})\\b",
      "group": 1
    },
    {
      "id": "internal-host",
      "type": "literal",
      "values": ["build.internal.example"],
      "strategy": "fixed",
      "replacement": "host-{n}.example"
    },
    { "id": "email", "enabled": false }
  ],
  "protectedPaths": ["**/fixtures/customers/**", "!**/*.tfvars"]
}
```

- `client-names` hides the values of the `CLIENT_NAME` and `CLIENT_CODE` environment variables.
- `ticket-id` hides the number in `TICKET-1234`, and keeps `TICKET-`.
- `internal-host` replaces `build.internal.example` with `host-`, a number and `.example`, for example `host-1.example`.
- The `email` entry turns off the default email rule.
- `protectedPaths` adds a folder and removes the default `**/*.tfvars` glob.

## Settings

| Setting | Default | Effect | Levels |
|---|---|---|---|
| `rules` | The default rules | The rules. See [Rule types](#rule-types). | Global and project |
| `protectedPaths` | See [Default protected paths](#default-protected-paths) | Globs. The extension refuses `read`, `grep`, `find` and `ls` when the path argument, or the target of a link, matches one. | Global and project |
| `networkCommands` | `curl`, `wget`, `ssh`, `scp`, `sftp`, `rsync`, `nc`, `ncat`, `telnet`, `ftp`, `socat`, `openssl s_client`, `git push`, `gh`, `glab`, `npm publish`, `pnpm publish`, `yarn publish`, `docker push`, `docker login`, `podman push`, `podman login`, `aws`, `gcloud`, `az`, `kubectl`, `helm`, `xh`, `python -c`, `python3 -c`, `node -e`, `node --eval`, `node -p`, `node --print`, `deno eval`, `bun -e`, `bun --eval`, `bun -p`, `bun --print`, `perl -e`, `perl -E`, `ruby -e`, `php -r`, `eval`, `dev/tcp`, `dev/udp` | Command words, not regexes. The words of an item can have up to 10 other words between them. A `bash` command that contains one of these words keeps its fakes. | Global and project |
| `restoredTools` | pi: `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`. Claude Code: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`. | The built-in tools whose arguments get real values back. Only these tools are allowed, so you can only remove tools. | Global only |
| `withholdHiddenCopies` | `true` | Withholds a text of a request that holds a known secret in a hidden form: spaced out, wrapped, reversed or encoded. See below. | Global only |
| `scanTimeoutMs` | `5000` | The time limit of one search, in milliseconds. A slower search blocks its request. The maximum is `2147483647`. | Global only |

About `withholdHiddenCopies`:

- Set it to `false` if it withholds ordinary output.
- A prefixed token glued to a word, such as `xghp_...`, stops the request in both cases, unless the vault already holds the token.
- In both cases, a request masks the run of letters and digits around a known secret glued to other text. For example, in `build_<secret>`, `build_` stays. It also masks a copy in another case when the secret has a digit and 8 or more characters, such as `te1234567` for `TE1234567`. The run gets its own fake, and that fake restores to the exact spelling. A copy of a value of a `mask` or `block` rule stops the request instead.
- With `false`, a copy split by spaces passes.
- A value of your own rules with 4 to 7 characters is checked only as you wrote it. A copy in another case, with spaces, reversed or encoded passes in both cases. A value under 4 characters glued to a word is not checked.

About `networkCommands`: the check reads the command as written, and again with its quotes and backslashes removed. It reads that form once with its line continuations joined and once with each line break kept. So `"curl"`, `$'curl'`, `c\url` and `bash -c 'curl ...'` keep their fakes. The words of an item can have up to 10 other words between them, so `git -C repo push` and `git commit -m wip; echo push` keep their fakes too.

The check is not a sandbox. Any shell expansion can still hide a command, such as a split variable, a default value, an escape code or a glob. Code on standard input, combined options, more than 10 words between the words of an item, or a program outside the list also hide it. Examples are `X=cu; ${X}rl`, `${X:-curl}`, `$'\x63url'`, `/usr/bin/cu?l`, `python3 - <<'EOF'` and `python -uc`. A word also matches in a path, in quoted text, or before a `-` or a `.`, such as `cat infra/aws/main.tf` or `npm i aws-sdk`. Then that command keeps its fakes.

### Default protected paths

`**/.env*`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/*.jks`, `**/id_rsa*`, `**/id_ed25519*`, `**/.ssh/**`, `**/.aws/**`, `**/.kube/**`, `**/.gnupg/**`, `**/.config/gcloud/**`, `**/.docker/config.json`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/.git-credentials`, `**/*.tfvars`, `**/*.tfstate`, `**/secrets.yaml`, `**/secrets.yml`, and the files of lmsk: `**/lmsk-vaults/**` and `**/lmsk/config.json`, and with pi `**/.pi/lmsk.json`.

Each agent also protects the folders of lmsk, `~/.config/lmsk/` and `~/.local/state/lmsk/`. With Claude Code, a tool call whose path becomes a protected path after restore keeps its fakes. The hook of Claude Code also checks each word of a shell command. See [How the hook works](claude-code.md#how-the-hook-works).

A protected path checks only the path argument of `read`, `grep`, `find` and `ls`. A `grep` or `find` on a whole folder, or a `bash` command, can still read a protected file. The masking rules still apply to that output.

## Rule types

Each rule has these fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | A unique name. It starts with a letter or a digit, then letters, digits, `.`, `_` or `-`. |
| `type` | Yes, for a new rule | `literal`, `env`, `regex` or `keyed`. |
| `enabled` | No | `false` turns the rule off. The default is `true`. |
| `strategy` | No | How to make the fake. See [Strategies](#strategies). The default is `opaque`, except for the `email` and `local-identity` rules, which use `shape`. |
| `replacement` | For `fixed` | The text of the fake. See [Strategies](#strategies). |

The other fields depend on the type.

### `literal`

Hides the exact texts in `values`.

```json
{ "id": "my-words", "type": "literal", "values": ["Project Falcon", "ACME-4471"] }
```

- Upper and lower case must match. Write each spelling that can occur: upper case, short name, web domain.
- A text that starts or ends with a letter or a digit matches only as a whole word. So `Falcon` does not match in `Falcons`.
- The configuration file keeps these texts in clear. For a password, use an `env` rule.

### `env`

Hides the current values of environment variables. The extension reads the values when the session starts. Use this rule to keep a value out of the configuration file.

| Field | Meaning |
|---|---|
| `vars` | The names of the variables. |
| `namePattern` | A regex, without case. Each variable whose name matches it is hidden. |
| `locationNamePattern` | A regex for names that hold a location, such as a URL. See below. |

The rule needs `vars`, `namePattern`, or both.

```json
{ "id": "my-passwords", "type": "env", "vars": ["DB_PASSWORD", "SMTP_PASS"] }
```

For `namePattern`, the extension skips these values. It never skips a `vars` value.

- A value under 8 characters.
- A value of digits only.
- A value that starts with `/` and is the path of a file or folder that exists, such as the value of `SSH_AUTH_SOCK`. A Windows path, such as `C:\Users\...`, is not skipped.
- A lowercase host name or URL without a password, when the name matches `locationNamePattern`. For example, `AUTH_URL=http://localhost:3000` is skipped.

#### The default rule `env-secret-names`

This default rule hides the values of variables whose names hold a secret word:

- `TOKEN`, `SECRET`, `PASS`, `PAT`, `PWD`, `KEY`, `CREDENTIAL` or `AUTH`, with an optional `S`, as a whole part of the name, such as `GITHUB_TOKEN`.
- `PASSWORD`, `PASSWD`, `PASSPHRASE` or `APIKEY` anywhere in the name.

`PUBLIC_KEY` matches too. Its value is masked, and the real value goes back into tool arguments. The rule sets `locationNamePattern` to names that end in `URL`, `URI`, `HOST`, `DOMAIN`, `ENDPOINT` or `ISSUER`. To turn it off, use `{ "id": "env-secret-names", "enabled": false }`.

### `regex`

Hides each text that matches a regex.

| Field | Meaning |
|---|---|
| `pattern` | The regex. |
| `flags` | Regex flags: `i` (no case), `m`, `s` or `u`. The default is none. |
| `group` | The number of the capture group to hide. `0`, the default, hides the full match. `"auto"` takes the first group that is not empty. |
| `keywords` | Optional. The rule runs only on text that contains one of these words. The check ignores the case of the text, so write each keyword in lowercase. |
| `entropy` | Optional. The minimum randomness of the value. A lower value is not hidden. |
| `validate` | Optional. A check that the value must pass: `luhn` (payment card), `iban`, `fr-nir`, `public-ipv4` or `public-ipv6`. |
| `allow` | Optional. Exceptions. Each one has a `target` (`secret`, `match` or `line`), `regexes`, `stopwords` and `all`. |

The last four fields reduce false positives: texts that look like a secret but are not one.

```json
{ "id": "ticket-id", "type": "regex", "pattern": "\\bTICKET-(\\d{4,})\\b", "group": 1 }
```

This rule hides the name of an employer in several spellings:

```json
{
  "id": "employer",
  "type": "regex",
  "pattern": "\\bAcme\\b|acme\\.example",
  "strategy": "fixed",
  "replacement": "Company{n}"
}
```

The `|` sign means "or". Write `\\.` for a dot. The `fixed` strategy replaces each name with `Company` and a number, for example `Company1` for `Acme`. The match is case-sensitive, so `ACME` stays unchanged. Add each spelling to the pattern.

The variants of one name share one number. A variant can differ in case, in the signs between its letters, or in a longer word around the name. The fake keeps the case and the first sign of its variant, so the model can search, count and group the variants by the number. Without a group called `name`, the whole match is the name, and the fake keeps no text of the match. To keep the rest of a longer word, put the name in the group `(?<name>...)`. The fake then keeps the text around the group, and this text goes to the model provider in clear, so do not let the pattern match a secret around the name. Start the pattern with `(?<!\w)`. Without it, the scan time of a long word grows with the square of its length, and a word of some 50,000 characters can stop the scan and block the request. When the text around the group has a digit, a `literal` or `env` value, or a match of another rule, the fake keeps no text of the match, and the match gets its own number. This rule hides `AcmeCorp`, `ACMECORP`, `Acme Corp`, `AcmeCorpTheme` and `@acmecorpcode/ui` as `Client1`, `CLIENT1`, `Client 1`, `Client1Theme` and `@client1code/ui`:

```json
{
  "id": "client",
  "type": "regex",
  "pattern": "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
  "flags": "i",
  "strategy": "fixed",
  "replacement": "Client{n}"
}
```

Each variant keeps its own fake, and each fake restores to exactly its variant. A search of `Client1` with `-i` reaches the disk as a search of `AcmeCorp`, so it finds the variants in another case. It does not find a variant with a sign, such as `Acme Corp`.

Put a letter or a digit before `{n}` in the replacement, as in `Client{n}`. With a sign before `{n}`, as in `Client-{n}`, variants that differ only in their signs get different numbers.

### `keyed`

Hides a value that follows one of the `keys`, for example in `clientId: abc123` or `"clientId": "abc123"`. The value must match the regex in `value`. Write each key in camelCase. The key `apiKey` also matches `api_key`, `API-KEY` and `X_API_KEY`.

```json
{ "id": "order-id", "type": "keyed", "keys": ["orderId"], "value": "[A-Za-z0-9-]{6,}" }
```

## Strategies

| Strategy | Fake | Real value back in tools |
|---|---|---|
| `opaque` (default) | A random value of the same length, made of letters and digits. An email keeps its `@`. | Yes |
| `shape` | A random value that keeps the class of each character. Digits stay digits, and an email keeps its `@` and its dots. A value of 2 to 4 letters gets letters and digits instead, so that its fake is no short word. A card fake can fail the Luhn check, and an IPv4 fake can be a private address. | Yes |
| `fixed` | The `replacement` text. It must contain `{n}`, which becomes a different number for each different name, for example `Company1` and `Company2`. The variants of one name share a number, see [`regex`](#regex). | Yes |
| `mask` | The `replacement` text, the same for every value. The default is `[MASKED]`. | No |
| `block` | No fake. The extension cancels the request. | Not applicable |

An enabled `fixed` rule without `{n}` in `replacement` blocks the session with the `UNEXPECTED_ERROR` code.

## What the default rules detect

| Class | Examples |
|---|---|
| Vendor keys | More than 200 token formats from the gitleaks default rules: cloud, payment, source control, chat and AI providers. |
| Keyed secrets | `password: ...`, `API_KEY=...`, `"token": "..."` in JSON, YAML, env files, CLI flags, cookies, netrc and SQL. Variables and placeholders such as `${DB_PASSWORD}` or `changeme` stay unchanged. |
| Credentials in structure | The password in `postgres://user:p4ss@host`, `Bearer` and `Basic` headers, and `--password` flags. A URL password that is a variable, a placeholder, or 8 to 15 letters and `_` stays unchanged. |
| Personal data | Emails, phone numbers (FR, US, E.164), IBANs, payment cards (Luhn), FR NIR, US SSN, public IP addresses, MAC addresses, UUIDs. |
| Identifiers | Values of 4 or more characters under `clientId`, `userId`, `accountId` and similar keys, identifiers such as `ORD-123456`, and account ids such as `AB1234567` or `AB1234567_team`. |
| Local identity | Your user name, host name and git identity. See [Local identity](#local-identity). |
| Your own values | Your `literal` and `env` rules, and the values of environment variables whose names hold a secret word. |

The ids of the default rules for personal data are `email`, `uuid`, `phone-fr`, `phone-us`, `phone-e164`, `iban`, `credit-card`, `fr-nir`, `us-ssn`, `ipv4`, `ipv6` and `mac`. The identifier rules are `keyed-id`, `prefixed-id` and `account-id`. Use an id to turn off a rule, for example `{ "id": "uuid", "enabled": false }`.

Names of people and postal addresses are not detected. They have no pattern. Add a `literal` rule for each one.

## Local identity

The `local-identity` rule hides these values, each one as a whole word:

- your user name on the computer,
- the short name of your computer (host name),
- your global git user name and email,
- the account name in a GitHub noreply email, such as `ana-dev` in `12345+ana-dev@users.noreply.github.com`.

The fakes keep the case and punctuation of each value, so `Jean Dupont` becomes a name such as `Qwqp Afytzn`. A value of one character is skipped. To turn the rule off, put `{ "id": "local-identity", "enabled": false }` in the global file.

Limits of this rule:

- Upper and lower case must match. If git has `John Smith`, then `JOHN SMITH` and `johnsmith` pass.
- The user name, the host name and the git user name are names, not secrets. A spaced or encoded copy of them does not stop the request. The git email is still treated as a secret.
- One word of a host name, such as `internal`, is not masked alone.
- A value that is a common word, such as `node`, `user` or `localhost`, is masked each time that word occurs as a whole word. The model reads the fake instead.
- A network command keeps its fakes. So `curl http://localhost:3000` fails when your host name is `localhost`.

## The schema file

[`schema/config.schema.json`](../schema/config.schema.json) describes the full configuration, after the extension adds the defaults. So an editor that checks your file against it can report a missing `enabled`, `strategy` or `type`. The extension accepts a file without these fields.

## If the configuration is wrong

The extension blocks every request that needs masking, and pi shows `lmsk: CONFIG_INVALID`. The message does not tell which part is wrong. To find it, read [CONFIG_INVALID](TROUBLESHOOTING.md#config_invalid).
