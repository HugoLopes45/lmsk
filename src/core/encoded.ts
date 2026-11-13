/**
 * The decoded text of an encoded run. `encode` writes a same-length ASCII
 * replacement of `text` back in the shape of the original run.
 */
export interface View {
  start: number;
  end: number;
  text: string;
  encode(text: string): string;
}

const B64 = "[A-Za-z0-9+/_-]";
const WRAPPED_LINE = `(?:${B64}{64}|${B64}{76})\\r?\\n`;
// A run starts only where no base64 character or `%` precedes it, except after `%2E`, which reads
// as a dot. So the tail of a run longer than the bound is not decoded. A data: URI is not decoded.
const BASE64_RUN = new RegExp(
  `(?:(?<=%2[Ee])|(?<![A-Za-z0-9+/_%-]))(?<!;base64,)(?:(?:${WRAPPED_LINE}){1,1024}(?:${B64}{1,76}={0,2}(?=\\r?\\n|$))?|${B64}{16,4096}={0,2})`,
  "g",
);
// An escape of a byte outside printable ASCII ends a run, since a view holds only printable ASCII.
// Its hex digits, left in the text, start no run. The bound keeps the regex stack small; see
// `percentRuns`.
const PERCENT_RUN =
  /(?:(?<!%[0-9A-Fa-f]?)[A-Za-z0-9._~-]|%(?:0[9AaDd]|[2-6][0-9A-Fa-f]|7[0-9A-Ea-e])){1,4096}/g;
const PERCENT_TOKEN = /%([0-9A-Fa-f]{2})|./g;
const UNRESERVED = /[A-Za-z0-9._~-]/;
// Every decoded byte must be printable ASCII or a line break. Random bytes
// (PNG, gzip, protobuf) fail at once, and a non-ASCII byte would change the
// encoded length of an ASCII replacement.
const PRINTABLE = /^[\t\n\r\x20-\x7e]+$/;
// Only single characters, so `20.24.10.15` or a date never joins into one run.
const SPELLED = /(?:\S[,.;:|] ?){7,}\S/g;
// Single characters between whitespace, as `od -c` or one character per line print them. Whole
// whitespace removal would join neighbouring words into values that a rule matches.
const SPACED = /(?<!\S)\S(?:\s+\S(?!\S)){7,}/g;
// The offset and the character column of an `xxd` or `hexdump -C` line, around its hex groups.
const XXD_LINE = /\b[0-9a-f]{7,}(?::| ) ((?:[0-9a-f]{2,4} {1,2})+) .*$/gim;
// The octal offset that starts each `od` line, which is not part of the value. A run alone on
// its line stays, because it can be plain hex, such as an `xxd -p` line of the digits 0-7.
const OD_OFFSET = /^[ \t]*[0-7]{6,}(?=[ \t]+\S)/gm;

/** Writes `chars` into `template` where `template` has no line break. */
function fill(template: string, chars: string): string {
  let out = "";
  let i = 0;
  for (const char of template) {
    if (char === "\r" || char === "\n") out += char;
    else out += chars.charAt(i++);
  }
  return out;
}

function base64View(run: string, start: number): View | undefined {
  const chars = run.replace(/\r?\n/g, "");
  const text = Buffer.from(chars, "base64").toString("latin1");
  if (!PRINTABLE.test(text)) return undefined;
  const url = /[-_]/.test(chars);
  const padded = chars.endsWith("=");
  const encode = (replacement: string): string => {
    let encoded = Buffer.from(replacement, "latin1").toString("base64");
    if (url) encoded = encoded.replaceAll("+", "-").replaceAll("/", "_");
    if (!padded) encoded = encoded.replace(/=+$/, "");
    return fill(run, encoded);
  };
  if (encode(text) !== run) return undefined;
  return { start, end: start + run.length, text, encode };
}

function percentView(run: string, start: number): View | undefined {
  if (!run.includes("%")) return undefined;
  const tokens = Array.from(run.matchAll(PERCENT_TOKEN), ([token, hex]) => ({
    token,
    hex,
  }));
  const chars = tokens.map(({ token, hex }) =>
    hex === undefined ? token : String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const text = chars.join("");
  // Encoders escape every character outside the unreserved set, or escape
  // every character. A `%32` in code mixes one escape with literal text, so
  // it is not an encoded run.
  const escapesAll = tokens.every(({ hex }) => hex !== undefined);
  const escapesReserved = tokens.some(
    ({ hex }, i) => hex !== undefined && !UNRESERVED.test(chars[i]),
  );
  if (!(escapesAll || escapesReserved)) return undefined;
  const encode = (replacement: string): string =>
    tokens
      .map(({ hex }, i) => {
        if (hex === undefined) return replacement.charAt(i);
        const code = replacement.charCodeAt(i).toString(16).padStart(2, "0");
        return `%${/[a-f]/.test(hex) ? code : code.toUpperCase()}`;
      })
      .join("");
  return { start, end: start + run.length, text, encode };
}

function isView(view: View | undefined): view is View {
  return view !== undefined;
}

/** The percent runs of `text`, with back-to-back matches of `PERCENT_RUN` joined into one. */
function percentRuns(text: string): { start: number; run: string }[] {
  const runs: { start: number; run: string }[] = [];
  for (const match of text.matchAll(PERCENT_RUN)) {
    const last = runs.at(-1);
    if (last && last.start + last.run.length === match.index)
      last.run += match[0];
    else runs.push({ start: match.index, run: match[0] });
  }
  return runs;
}

/**
 * Views of the base64 and percent-encoded runs of `text`, one level deep,
 * sorted by start. A percent run that overlaps a base64 view is dropped: it
 * would expose the encoded text, not the decoded secret.
 */
export function decodedViews(text: string): View[] {
  const base64 = Array.from(text.matchAll(BASE64_RUN), (match) =>
    base64View(match[0], match.index),
  ).filter(isView);
  const percent = percentRuns(text)
    .map(({ start, run }) => percentView(run, start))
    .filter(isView)
    .filter(
      (view) =>
        !base64.some(
          (other) => other.start < view.end && view.start < other.end,
        ),
    );
  return [...base64, ...percent].sort((a, b) => a.start - b.start);
}

const HEX_RUN = /[0-9A-Fa-f]{8,}/g;
// One pass per family, as in JSON and HTML, so a `\\` or `&` that a pass decodes starts no escape in that pass.
// Markdown, as in a fetched web page, can escape any ASCII punctuation.
const ESCAPE = /\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[!-/:-@[-`{-~])/g;
const ENTITY =
  /&(?:#0*(\d{1,7})|#[xX]0*([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const CHAR_CODES = /\b\d{2,3}(?:[,;\s]+\d{2,3}){3,4096}\b/g;

function fromHex(text: string, shift: number): string {
  return text.replace(HEX_RUN, (run) =>
    Buffer.from(run.slice(shift), "hex").toString("latin1"),
  );
}

function fromEscape(_: string, escape: string): string {
  return escape.length === 1
    ? escape
    : String.fromCharCode(Number.parseInt(escape.slice(1), 16));
}

/** `fromCodePoint` throws past the last code point, so such an entity stays. */
function fromEntity(
  entity: string,
  decimal: string | undefined,
  hex: string | undefined,
  name: string | undefined,
): string {
  if (name !== undefined) return NAMED_ENTITY[name];
  const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}

function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * Readings of tool output in which a value hides from a plain match: spaced out, as `od -c`
 * (octal offsets removed) or spelled one character at a time between `,.;:|`, reversed, rot13,
 * hex at either alignment (also as `xxd`, `xxd -u` or `hexdump -C` print it), `\x` and `\u` escapes, a backslash before punctuation (as JSON and Markdown write it), HTML entities, and decimal
 * character codes, of the text and of each decoded view after `neutral`. Whitespace stays, except
 * between hex digits, so words do not join.
 */
export function hiddenReadings(
  text: string,
  neutral: (text: string) => string,
): string[] {
  return [text, ...decodedViews(text).map((view) => view.text)]
    .map(neutral)
    .flatMap(readingsOf);
}

function readingsOf(text: string): string[] {
  const unprefixed = text.replace(OD_OFFSET, "");
  const joined = unprefixed
    .replace(SPACED, (run) => run.replace(/\s+/g, ""))
    .replace(SPELLED, (run) => run.replace(/(\S)[,.;:|] ?/g, "$1"));
  const hex = text
    .replace(XXD_LINE, "$1")
    .replace(OD_OFFSET, "")
    .replace(/(?<=[0-9A-Fa-f])\s+(?=[0-9A-Fa-f])/g, "");
  return [
    joined,
    [...joined].reverse().join(""),
    rot13(joined),
    fromHex(hex, 0),
    fromHex(hex, 1),
    text.replace(ESCAPE, fromEscape).replace(ENTITY, fromEntity),
    text.replace(CHAR_CODES, (run) =>
      String.fromCharCode(...run.split(/[,;\s]+/).map(Number)),
    ),
  ];
}
