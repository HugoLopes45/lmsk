# Security policy

## Supported versions

Security fixes target the latest published release. Older releases do not have a separate maintenance branch.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/HugoLopes45/lmsk/security/advisories/new).

Include:

- The affected package and Pi versions.
- The impact and minimal reproduction steps using synthetic data.
- A proposed fix, if available.

Never attach access tokens, credentials, private conversation content, or session files.

Do not publish exploit details in issues or pull requests before you agree on disclosure with the maintainer.

This is a volunteer-maintained project. No response or resolution deadline is guaranteed.

## Scope and limitations

Use the private channel to report:

- a value that reaches the model provider unmasked,
- a masked value that gets its real value back in the wrong place,
- a fail-open path: an error that lets a request go out instead of stopping it,
- any other vulnerability in this extension.

For false positives (ordinary text that the extension masks) or compatibility errors, open a public issue with synthetic data.

The pi extension runs inside Pi with the permissions of the Pi process. The Claude Code proxy runs with the permissions of the user who starts `lmsk`. It reduces what the model provider can see. It is not a sandbox. It does not protect against other extensions, tools that send data themselves, or a compromised machine. Install extensions only from sources you trust.
