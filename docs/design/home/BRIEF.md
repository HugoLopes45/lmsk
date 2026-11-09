# Home page and logo

Route: `docs/index.html` (https://hugolopes45.github.io/lmsk/). Logo: `docs/brand/`.

## Direction

Chosen by the owner on 2026-11-09 from three rendered mockups (codebook, carbon copy, cloakroom ticket). Kept: `mockup-codebook.html`.

```text
Idea: lmsk keeps a codebook on your computer; the AI company only ever reads the coded line.
Surface: docs/index.html; mode: Persuade; family: software
Task: a developer who uses pi or Claude Code understands what leaves the computer, installs lmsk with one command, and runs the test message; success = the reply shows a different value after API_KEY=.
Dials: density airy; expression voiced
World: one-time pad and codebook sheets (aligned character groups, black and red print, ruled rows, tiny column numbers) because lmsk does exactly what a codebook does: a same-length substitution that only the holder of the book can reverse.
Avoids: security-tool default (dark page, neon green terminal, shield or lock icon, purple gradient, three feature cards) because it says "security" without showing what lmsk does.
Removed: feature card grid, shield and lock icons, badges, invented numbers, because the worked example proves the claim better.
Composition: word-led opening view: headline and lead, then the codebook sheet across the full width as the dominant element; install command in the first view at 1440x900. Reading order: headline, codebook, install.
Type: Public Sans (variable, OFL, docs/fonts/public-sans.woff2) for all text, weights 400/600/800; IBM Plex Mono 400/600 (OFL, docs/fonts/) only for values, commands and code. Ratio 1.25, body 18px, measure 60ch, display clamp(2.5rem, 1.6rem + 3.4vw, 4.5rem).
Color: restrained; ink oklch(0.22 0.02 255) for text and the primary button; print red oklch(0.52 0.19 27) only for what is sent to the AI (fakes) and the logo; neutrals tinted to hue 255; light and dark themes from prefers-color-scheme.
Shape and depth: radius 4px on controls and code, 8px on the logo icon (scaled); 2px ink rules for the codebook, 1px dashed rules between rows; no shadows; no icon set (the logo is the only drawn mark).
Signature: the codebook sheet: each real value and its fake on aligned rows, with a column ruler every 5 characters, so the same length is visible.
Motion: none, except the copy button label change (no animation).
Voice: plain, exact, calm; button pattern verb + object ("Copy command").
States: copy button default, focus-visible, copied ("Copied"), copy failed ("Select the text and copy it"); no-JS: commands stay selectable text.
Checks: render 1440x900, 1024x768, 390x844, 320 wide; dark theme; 200% text; scan source and render; contrast pairs computed; keyboard path through nav, copy buttons, links.
```

## Logo

The icon is a codebook row: a white bar (the real value) above a red bar of the same total length, cut into groups (the fake). The wordmark is `lmsk` in Public Sans ExtraBold, outlined to paths so it renders without the font.

## Acceptance checks

| Check | Status | Evidence |
|---|---|---|
| Headline, codebook and install command in first view at 1440x900 | pending | |
| No horizontal overflow at 320 CSS px | pending | |
| Dark theme renders with computed contrast | pending | |
| Scan: 0 failures in source and render | pending | |
| Copy buttons work by keyboard and show state | pending | |
| Logo legible at 16, 32 px and in README light/dark | pending | |
