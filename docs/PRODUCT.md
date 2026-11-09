# lmsk

## Audience and tasks

- Developers who use an AI coding agent (pi, Claude Code) on projects that contain secrets, customer data or client names. Source: README.md "Why".
- Many are "everyday developers", not security specialists. Source: commit 62800e5 "Add a landing page for everyday developers".
- Task on the website: understand in one view what lmsk does, believe that the real values stay on the computer, install with one command, and test it with the test key. Success: the visitor runs the install command and sees a different value after `API_KEY=`.

## What it does and does not do

- Replaces secrets, emails, phone numbers, IBANs, card numbers, ids, user and host names, and listed client names with fakes before each request leaves the computer. Source: README.md "Features".
- Each fake keeps the length of its real value. The same real value gets the same fake for the whole session. Built-in tools get the real values back. Source: README.md.
- Fail closed: if it cannot mask a request safely, it cancels the request. Source: README.md.
- The real values stay in a vault: a plain JSON file, mode 0600, not encrypted. Source: README.md FAQ.
- Does not hide code. Does not catch every secret (pattern detection). Is not a sandbox. Source: README.md FAQ, docs/GUIDE.md.

## Platforms and inputs

- pi extension (supported): `pi install npm:@lmsk/pi`.
- Claude Code local proxy (preview): `npm install -g lmsk`, then `lmsk claude`.
- Website: static `docs/index.html`, served from https://hugolopes45.github.io/lmsk/. Desktop and phone browsers.

## Accessibility laws

None named by the owner. The site follows WCAG 2.2 AA as the floor.

## Brand commitments

- Name: `lmsk`, lowercase, "LLM mask".
- Status: early (0.1). The site says so.
- Local only. No model, no account, no telemetry.
- MIT license.

## Voice

Plain, exact, calm. Short sentences in ASD-STE100 style. No hype words. Say what it does not do.

## Non-goals

- No testimonials, user counts or detection rates: none exist.
- No claim that lmsk catches every secret.

## Open questions

- Is GitHub Pages set to serve the `docs/` folder? The README links to the URL; the repository has no Pages workflow.

## Sources

README.md, docs/index.html, docs/GUIDE.md, git log.
