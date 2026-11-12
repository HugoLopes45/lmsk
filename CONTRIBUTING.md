# Contributing

Small, focused contributions are welcome. Discuss large behavior changes in an issue before implementing them.

## Local checks

Use Node.js 22.19 or later. CI checks Node 22 and 24.

```bash
npm ci
npm run check
```

`npm run check` validates package and lockfile metadata, release notes, TypeScript, and the offline tests. The tests use Pi's faux provider and local stand-ins for Claude Code and the providers, not a real model. The tests and type checks read the TypeScript in `src/`; `npm run build` writes the JavaScript in `dist/` that the published package uses.

CI also installs the latest published Pi packages on Node 24 and runs these checks again. It also runs once a week, even when the repository does not change.

Keep the lockfile reproducible. Do not replace it with an unbounded dependency tree. The peer dependencies that Pi provides stay `*`.

To test the extension by hand in Pi, run this command in the repository:

```bash
pi -e ./src/pi/extension.ts
```

To test the proxy by hand, stop an installed service first, because it uses the same port. Run `npm run build`, then `node dist/cli/bin.js serve`. Then start Claude Code with a `--settings` file that sets `env.ANTHROPIC_BASE_URL` to `http://127.0.0.1:25675/` and the token in `~/.local/state/lmsk/serve-token`. An `ANTHROPIC_BASE_URL` in your shell loses to your user settings.

Do not load another copy of this extension in the same session. If you installed the package with `pi install`, remove it first, or the session loads two copies.

## Changes

- Keep the extension independent of personal paths, prompts, and other extensions.
- Preserve unrelated user instructions and session content.
- Prefer existing Pi APIs and small changes over new dependencies or abstractions.
- Add a regression test for a bug and check that it fails before the fix.
- Do not weaken tests or input validation to pass checks.
- Describe user-visible changes under `Unreleased` in `CHANGELOG.md`.
- Never include credentials, account data, or private conversation content in commits, screenshots, or logs.

## Pull requests

Open a branch or fork, then submit a pull request against `main`.

Explain the problem, the minimal fix, and the checks you ran. Keep unrelated changes in separate pull requests.

`main` requires a pull request and successful `Check (Node 22)` and `Check (Node 24)` checks against the current base.

No approval from another person is required, so a solo maintainer can merge after CI succeeds. Force pushes and branch deletion are blocked.

## Releases

Release preparation requires Node 24 or later, npm publish permission through the configured workflow, and an authenticated GitHub CLI.

To prepare a release:

1. On a clean `main` that equals `origin/main`, run `npm run release -- <patch|minor|major|X.Y.Z>`.
2. The script creates the branch `release/vX.Y.Z` and moves the `Unreleased` notes of `CHANGELOG.md` under a heading for the version. It then updates both manifests, runs `npm run check`, pushes the branch and opens a pull request.
3. After the merge, tag the merged commit of `main` as `vX.Y.Z` and push the tag.
4. Run **Publish release** on that tag ref, with the same tag as input.

Do not bump the package version in ordinary contribution pull requests.

Merging a release PR only prepares the version. The PR must update both manifests and include nonempty versioned release notes. CI rejects version rollback.

Only the repository owner can launch **Publish release** from an explicit `vX.Y.Z` tag whose commit belongs to `main`. The owner must also approve the `npm` environment deployment. Pushes and tag creation do not publish.

Retry a failed release from its original Actions run and tag. Do not move any release tag or reuse its version for different code. If the code needs a fix, open another release PR with a new version instead.

## Security

Use the [private reporting process](SECURITY.md) for vulnerabilities. Do not put exploit details or credentials in a public issue.
