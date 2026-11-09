---
name: lmsk
colors:
  canvas: "oklch(0.985 0.004 255)"
  sunken: "oklch(0.955 0.008 255)"
  text: "oklch(0.22 0.02 255)"
  text-muted: "oklch(0.45 0.02 255)"
  rule: "oklch(0.86 0.01 255)"
  fake: "oklch(0.52 0.19 27)"
  button-hover: "oklch(0.32 0.02 255)"
  dark-canvas: "oklch(0.18 0.015 255)"
  dark-sunken: "oklch(0.24 0.02 255)"
  dark-text: "oklch(0.93 0.01 255)"
  dark-text-muted: "oklch(0.74 0.015 255)"
  dark-rule: "oklch(0.36 0.015 255)"
  dark-fake: "oklch(0.72 0.16 27)"
  dark-button-hover: "oklch(0.86 0.01 255)"
  logo-ink: "#141b24"
  logo-white: "#ffffff"
  logo-red: "#ed4b43"
  logo-red-on-light: "#be2323"
  logo-light: "#e3e8ef"
typography:
  body:
    fontFamily: Public Sans
    fontSize: 1.125rem
  lead:
    fontFamily: Public Sans
    fontSize: 1.375rem
  h2:
    fontFamily: Public Sans
    fontSize: 2.25rem
  h3:
    fontFamily: Public Sans
    fontSize: 1.375rem
  small:
    fontFamily: Public Sans
    fontSize: 0.875rem
  code:
    fontFamily: IBM Plex Mono
    fontSize: 1rem
rounded:
  control: 4px
  icon: 7px
---
# lmsk design system

Source: `docs/index.html` (custom properties in `:root`), `docs/brand/`. Direction: `docs/design/home/BRIEF.md`.

## Principles

- Show the codebook, not a shield: every claim sits next to a real value and its fake.
- Red means "this is what the AI company gets", not decoration and not error.
- Plain sentences, not hype: say what lmsk does not do.

## Dials

Density airy, expression voiced. The voice lives in two places: the logo and the codebook sheet.

## Color

Restrained. Neutrals tinted to hue 255 (blue-black ink). One accent, print red at hue 27, used only for fakes, the focus ring, text selection and the logo.

| Role | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | oklch(0.985 0.004 255) | oklch(0.18 0.015 255) | page |
| `--sunken` | oklch(0.955 0.008 255) | oklch(0.24 0.02 255) | the fail-closed note |
| `--text` | oklch(0.22 0.02 255) | oklch(0.93 0.01 255) | text, 2px rules |
| `--text-muted` | oklch(0.45 0.02 255) | oklch(0.74 0.015 255) | labels, captions, keys |
| `--rule` | oklch(0.86 0.01 255) | oklch(0.36 0.015 255) | dashed rows, footer line |
| `--fake` | oklch(0.52 0.19 27) | oklch(0.72 0.16 27) | fake values, focus ring |
| `--code-bg` / `--button-bg` | `--text` value | `--sunken` / `--text` value | command blocks, primary button |

Computed WCAG contrast: text on canvas 16.6 (light), 15.3 (dark); muted on canvas 7.1 and 8.2; fake on canvas 5.8 and 7.1; fake on sunken 5.3 and 6.2.

## Type

- Public Sans (variable, OFL, `docs/fonts/public-sans.woff2`): all text. Weights 400, 600, 700, 800.
- IBM Plex Mono 400 and 600 (OFL, `docs/fonts/`): only values, commands and code.
- Scale ratio 1.25 from body 1.125rem: small 0.875rem, lead and h3 1.375rem, h2 2.25rem. Display `clamp(2.5rem, 1.6rem + 3.4vw, 4.5rem)`, weight 800, tracking -0.02em. Codebook values `clamp(0.95rem, 0.7rem + 1.1vw, 1.5rem)`.
- Measure 60ch for prose.

## Space, radius, depth

Section gap 4.5rem (3.5rem under 900px). Radius 4px on command blocks, buttons, focus ring and the note. No shadows. Groups use 2px ink rules (codebook, quotes) and 1px dashed rules (rows).

## Components

- **Codebook sheet** (`.book`): a caption, a column ruler (one tick per character, a long tick every 5), then one `.entry` per value: kind, "Stays on your computer" row, "What the AI company gets" row. The two values share a column, so equal length is visible. Under 760px the rows stack and the ruler hides.
- **Command block** (`.cmd`): ink block with the command in mono and a Copy button (min 44px high). States: Copy, Copied, Copy failed; a polite live region announces the result. The button stays hidden without JavaScript; the command stays selectable.
- **Button** (`.button`): ink fill, 48px high, verb + object label.

## Logo

`docs/brand/icon.svg`, `logo.svg` (light ground), `logo-dark.svg` (dark ground). The icon is one codebook row: a white bar (the real value) above a red bar of the same length, cut into groups (the fake), on a 32-unit grid with radius 7. The wordmark is `lmsk` in Public Sans ExtraBold (800), outlined to paths. The icon square is 1600 units for a 1486-unit `l`, with a 380-unit gap. `icon.svg` switches to the light square in dark mode. Do not recolor the bars, add a shield or lock, or set the wordmark in another face.

## Motion

None. The copy button changes its label without animation.

## Voice and glossary

- "AI company": the model provider. "Fake": the replacement value. "Codebook": the session's vault, shown on the page.
- Short ASD-STE100 sentences. No hype words.

## Exceptions

None.
