import { existsSync } from "node:fs";
import { type EnvRule, isRecord, type Rule } from "./config.ts";
import { decodedViews, hiddenReadings, type View } from "./encoded.ts";
import { CodedError } from "./errors.ts";
import { IDENTITY_RULE_ID } from "./identity.ts";
import {
  assertPayloadSize,
  mapPayload,
  type PayloadFormat,
  textsOf,
} from "./payload.ts";
import {
  escapeRegex,
  keyedPattern,
  literalPattern,
  type ScanPattern,
  type Scanner,
  type Span,
} from "./scanner.ts";
import {
  fixedFakePattern,
  isDistinctPart,
  MIN_LEARNED_LENGTH,
  Vault,
} from "./vault.ts";

export type MaskCode = "BLOCKED" | "HIDDEN_REAL";

export class MaskError extends CodedError<MaskCode> {}

/** The text of a `mask` rule without a replacement, and of withheld content. */
export const DEFAULT_MASK = "[MASKED]";
/** A shorter configured value glued to a word occurs by chance in ordinary text, such as `a1` in `sha1`. */
const MIN_GLUED_KNOWN_LENGTH = 4;
const ALNUM = /[A-Za-z0-9]/;
/** The word characters that `literalPattern` bounds, so a token is one maximal run. */
const TOKEN = /[\p{L}\p{N}_]+/gu;
const WORD = /[\p{L}\p{N}_]/u;
/** Tokens joined by dots or dashes, such as the domain of a `shape` email fake, whose tokens alone are too short to restore. */
const DOTTED = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)+/gu;
/** A line break in wrapped output, with the blanks around it: CRLF, LF or a lone CR. */
const WRAP = /[ \t]*\r?\n[ \t]*|\r/g;

/**
 * The spans that may be part of a fake, longest first: each dotted run, each of its heads and
 * tails cut at a dot or dash, as in `www.` before a domain, then each token.
 */
function partSpans(text: string): [start: number, end: number][] {
  const spans: [start: number, end: number][] = [];
  for (const run of text.matchAll(DOTTED)) {
    const end = run.index + run[0].length;
    spans.push([run.index, end]);
    for (const cut of run[0].matchAll(/[.-]/g))
      spans.push(
        [run.index, run.index + cut.index],
        [run.index + cut.index + 1, end],
      );
  }
  spans.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  for (const token of text.matchAll(TOKEN))
    spans.push([token.index, token.index + token[0].length]);
  return spans;
}

interface Target {
  rule: Rule;
  pattern: ScanPattern;
}

interface Hit {
  start: number;
  end: number;
  real: string;
  rule: Rule | undefined;
  /** For a rule with a `name` group, the slice of `real` that a fixed fake replaces, see `nameOf`. */
  name?: [start: number, end: number];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Rewrite {
  view: View;
  hits: Hit[];
}

/** A text's scan results. They hold while no vault entry from `size` on occurs in the text or its views. */
interface Scanned {
  views: View[];
  /** For the text, then for each view. */
  raw: Span[][];
  placeholders: [start: number, end: number][][];
  size: number;
}

interface TextPlan {
  outer: Hit[];
  rewrites: Rewrite[];
  /** Hits that lost an overlap. They are not rendered, but their reals are learned. */
  overlapped: Hit[];
}

/**
 * A value that a name pattern selects is masked only when it is long enough and not only digits, so
 * `PASS=1` masks nothing. An existing absolute path, such as `SSH_AUTH_SOCK`, is no secret, and its
 * words would be learned. So is a lowercase host name or a URL without credentials under a name that
 * `locationNamePattern` matches, such as `AUTH_URL=http://localhost:3000`; under other names, such as
 * `WEBHOOK_SECRET`, the URL path or a dotted passphrase is the secret.
 */
function isPatternValue(value: string, isLocation: boolean): boolean {
  return (
    value.length >= MIN_LEARNED_LENGTH &&
    !/^\d+$/.test(value) &&
    !(value.startsWith("/") && existsSync(value)) &&
    !(
      isLocation &&
      /^(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]*)*$/.test(
        value,
      )
    )
  );
}

/** The current values that an env rule selects: its `vars`, then the values of the names that `namePattern` matches. */
export function envValues(
  rule: EnvRule,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const named = (rule.vars ?? []).flatMap((name) => {
    const value = env[name];
    return value ? [value] : [];
  });
  if (rule.namePattern === undefined) return named;
  const pattern = new RegExp(rule.namePattern, "i");
  const location =
    rule.locationNamePattern === undefined
      ? undefined
      : new RegExp(rule.locationNamePattern, "i");
  const matched = Object.entries(env).flatMap(([name, value]) =>
    pattern.test(name) &&
    typeof value === "string" &&
    isPatternValue(value, location?.test(name) === true)
      ? [value]
      : [],
  );
  return [...named, ...matched];
}

function patternOf(
  rule: Rule,
  env: Readonly<Record<string, string | undefined>>,
): ScanPattern | undefined {
  switch (rule.type) {
    case "regex":
      return {
        source: rule.pattern,
        flags: rule.flags,
        group: rule.group,
        keywords: rule.keywords,
        entropy: rule.entropy,
        allow: rule.allow,
        validate: rule.validate,
      };
    case "literal":
      return literalPattern(rule.values, false);
    case "env": {
      const values = envValues(rule, env);
      return values.length > 0 ? literalPattern(values, false) : undefined;
    }
    case "keyed":
      return keyedPattern(rule.keys, rule.value);
  }
}

/** The views of `readings` that the glued check searches with transforms. */
function glueViews(readings: string[][]): {
  unwrapped: string[][];
  joined: string[][];
  folded: string[][];
} {
  const unwrapped = readings.map((list) =>
    list.map((reading) => reading.replace(WRAP, "")),
  );
  const joined = readings.map((list) =>
    list.map((reading) => reading.replace(/\s+/g, "")),
  );
  const folded = joined.map((list) =>
    list.map((reading) => reading.toLowerCase()),
  );
  return { unwrapped, joined, folded };
}

/** The tokens of four or more characters in `texts` that occur in a restored real. */
function restoredParts(texts: string[], restored: readonly string[]): string[] {
  if (restored.length === 0) return [];
  const tokens = texts.flatMap((input) =>
    [...input.matchAll(TOKEN)].map(([token]) => token),
  );
  return [...new Set(tokens)].filter(
    (token) =>
      token.length >= 4 && restored.some((real) => real.includes(token)),
  );
}

/** The maximal run of `chars` around `text[start, end)`. */
function runAround(
  text: string,
  start: number,
  end: number,
  chars: RegExp,
): string {
  let from = start;
  let to = end;
  while (from > 0 && chars.test(text.charAt(from - 1))) from--;
  while (to < text.length && chars.test(text.charAt(to))) to++;
  return text.slice(from, to);
}

/** Matches `values` anywhere: each value is a whole letter-and-digit run, so no span splits a token. */
function copiesPattern(values: readonly string[]): ScanPattern {
  const sorted = [...new Set(values)].sort((a, b) => b.length - a.length);
  return { source: sorted.map(escapeRegex).join("|"), flags: "u", group: 0 };
}

function splitsToken(text: string, start: number, end: number): boolean {
  return (
    (ALNUM.test(text.charAt(start - 1)) && ALNUM.test(text.charAt(start))) ||
    (ALNUM.test(text.charAt(end - 1)) && ALNUM.test(text.charAt(end)))
  );
}

/**
 * Spans arrive by start, longest first. Keeps the first of overlapping spans and drops any that split a token.
 * A span that ends past the kept one extends it with the kept rule, so no tail of a match stays clear.
 * Returns the spans that lost an overlap apart, so their reals can still be learned.
 */
function keptSpans(
  text: string,
  spans: Span[],
): { kept: { span: Span; end: number }[]; overlapped: Span[] } {
  const kept: { span: Span; end: number }[] = [];
  const overlapped: Span[] = [];
  let cursor = 0;
  for (const span of spans) {
    const [start, end] = span;
    if (splitsToken(text, start, end)) continue;
    if (start < cursor) {
      overlapped.push(span);
      if (end > cursor) {
        kept[kept.length - 1].end = end;
        cursor = end;
      }
      continue;
    }
    kept.push({ span, end });
    cursor = end;
  }
  return { kept, overlapped };
}

/** Applies edits that do not overlap, given in any order. */
function splice(text: string, edits: Edit[]): string {
  let out = "";
  let last = 0;
  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    out += text.slice(last, edit.start) + edit.text;
    last = edit.end;
  }
  return out + text.slice(last);
}

/** The encoded run is re-encoded at the length of the decoded text, so only same-length fakes fit. */
function assertShapeInRun(hit: Hit): void {
  if (
    hit.rule &&
    hit.rule.strategy !== "opaque" &&
    hit.rule.strategy !== "shape"
  )
    throw new MaskError(
      "BLOCKED",
      `rule ${hit.rule.id} matched inside an encoded run and cannot be re-encoded`,
    );
}

function fixedReplacement(rule: Rule): string {
  if (rule.replacement === undefined)
    throw new Error(
      `rule ${rule.id} needs a replacement for the fixed strategy`,
    );
  return rule.replacement;
}

/**
 * Masks text and payloads before they reach the provider, and restores fakes
 * in values coming back. `mask` rejects on any failure and returns no partial result.
 */
export class Masker {
  private readonly targets: Target[];
  private readonly scanner: Scanner;
  private readonly vault: Vault;
  private readonly format: PayloadFormat;
  /** The texts of the last masked payload: each payload repeats the history, which is not scanned again. */
  private history = new Map<string, Scanned>();
  /** The texts of the last payload that passed `assertNoHiddenRealInPayload`, with the vault size at their check. */
  private checked = new Map<string, number>();
  /** The texts of the tool results of the last payload that passed `hidingResults`, with the vault size at their check. */
  private resultsChecked = new Map<string, number>();
  /** Fixed templates of every fixed rule, enabled or not: the vault can hold their fakes after a rule is disabled. */
  private readonly fixedFakes: RegExp[];
  /** Identity names are not secrets: their words and case variants occur in ordinary text. An email stays a secret. */
  private readonly identity: Set<string>;
  /** The enabled literal and env values, which a transform can hide before any output holds them plainly. */
  private readonly known: string[];
  /** The known values whose copy can get a fake of its own. A `mask` or `block` value has no vault fake, so its copy stays withheld. */
  private readonly copyable: string[];

  constructor(
    rules: readonly Rule[],
    scanner: Scanner,
    vault: Vault,
    env: Readonly<Record<string, string | undefined>>,
    format: PayloadFormat,
  ) {
    this.scanner = scanner;
    this.vault = vault;
    this.format = format;
    this.fixedFakes = rules.flatMap((rule) =>
      rule.strategy === "fixed"
        ? [
            fixedFakePattern(
              fixedReplacement(rule),
              rule.type === "regex" && rule.pattern.includes("(?<name>"),
            ),
          ]
        : [],
    );
    this.identity = new Set(
      rules.flatMap((rule) =>
        rule.id === IDENTITY_RULE_ID && rule.type === "literal"
          ? rule.values.filter((value) => !value.includes("@"))
          : [],
      ),
    );
    const valuesOf = (rule: Rule) => {
      if (!rule.enabled) return [];
      if (rule.type === "literal") return rule.values;
      return rule.type === "env" ? envValues(rule, env) : [];
    };
    this.known = rules.flatMap(valuesOf);
    this.copyable = rules
      .filter((rule) => rule.strategy !== "mask" && rule.strategy !== "block")
      .flatMap(valuesOf);
    this.targets = rules.flatMap((rule) => {
      if (!rule.enabled) return [];
      if (rule.strategy === "fixed" && !rule.replacement?.includes("{n}"))
        throw new Error(`rule ${rule.id} needs {n} in its fixed replacement`);
      const pattern = patternOf(rule, env);
      return pattern ? [{ rule, pattern }] : [];
    });
  }

  /**
   * Masks provider-bound text. A placeholder already in it passes unchanged.
   * `restored` lists the reals that this call put back into its arguments. They are
   * masked in `texts` even when too short to learn, and so are their tokens of four or more
   * characters, so the call's own result hides them.
   * A command can also print part of a real that it read from a file, so a token that occurs in any
   * vault real is masked too when it is long enough to learn or looks random.
   */
  async mask(
    texts: string[],
    restored: readonly string[] = [],
  ): Promise<string[]> {
    const reals = [...new Set([...restored, ...this.derivedReals(texts)])];
    const copies = this.hiddenCopies(texts);
    const masked = await this.maskBatch(texts, reals, false, copies);
    // A real that these texts teach can have its own copies in them.
    const later = this.hiddenCopies(texts).filter(
      (copy) => !copies.includes(copy),
    );
    return later.length === 0
      ? masked
      : this.maskBatch(texts, reals, false, [...copies, ...later]);
  }

  /**
   * The letter-and-digit runs around each plain copy of a real that `assertNoHiddenReal` refuses: a
   * real with a letter and a non-letter, glued to a word or, when it has a digit, in another case.
   * Each run becomes its own value, so it restores to its own spelling and the output stays readable.
   * A run stops at `_`, so a word glued with `_` stays clear and later output does not mask it as a part.
   * A copy whose word is the real or a learned real is masked as a literal and is left out.
   */
  private hiddenCopies(texts: string[]): string[] {
    const learned = new Set(this.literalReals([]));
    const bare = (real: string) => real.replace(/\s+/g, "");
    const reals = [...learned, ...this.copyable].filter(
      (real) =>
        bare(real).length >= MIN_GLUED_KNOWN_LENGTH &&
        !this.identity.has(real) &&
        /\p{L}/u.test(real) &&
        /[^\p{L}]/u.test(bare(real)),
    );
    return reals.flatMap((real) => {
      const fold = bare(real).length >= MIN_LEARNED_LENGTH && /\d/.test(real);
      const pattern = new RegExp(escapeRegex(real), fold ? "giu" : "gu");
      return texts.flatMap((text) =>
        [...text.matchAll(pattern)].flatMap((match) => {
          const end = match.index + match[0].length;
          const word = runAround(text, match.index, end, WORD);
          return word === real || learned.has(word)
            ? []
            : [runAround(text, match.index, end, ALNUM)];
        }),
      );
    });
  }

  /**
   * The vault-real tokens that `mask` describes, and each real that occurs with its own fake.
   * The vault file pairs them, so such a real is masked at any length.
   */
  private derivedReals(texts: string[]): string[] {
    const entries = this.vault.entries();
    const parts = texts
      .flatMap((input) => [...input.matchAll(TOKEN)].map(([token]) => token))
      .filter(
        (token) =>
          isDistinctPart(token) &&
          entries.some(
            ([real]) => !this.identity.has(real) && real.includes(token),
          ),
      );
    const paired = entries
      .filter(([real, fake]) =>
        texts.some((text) => text.includes(fake) && text.includes(real)),
      )
      .map(([real]) => real);
    return [...parts, ...paired];
  }

  /** The reals to mask as literals: learned reals of learnable length, and `restoredReals`. */
  private literalReals(restoredReals: readonly string[]): string[] {
    const learned = this.vault
      .entries()
      .map(([real]) => real)
      .filter((real) => real.length >= MIN_LEARNED_LENGTH);
    return [...new Set([...learned, ...restoredReals])];
  }

  /**
   * Scans each text, except a text of `previous` that holds no `restoredReals` literal and no vault
   * entry added since its scan: its remembered spans would lack their literal spans.
   */
  private async scanned(
    texts: string[],
    patterns: ScanPattern[],
    previous: ReadonlyMap<string, Scanned>,
    restoredReals: readonly string[],
  ): Promise<Scanned[]> {
    const entries = this.vault.entries();
    const size = entries.length;
    const kept = texts.map((text) => {
      const known = previous.get(text);
      if (!known) return undefined;
      const inputs = [text, ...known.views.map((view) => view.text)];
      const touched = [
        ...entries.slice(known.size).flat(),
        ...restoredReals,
      ].some((value) => inputs.some((input) => input.includes(value)));
      return touched ? undefined : { ...known, size };
    });
    const missing = texts.filter((_, index) => !kept[index]);
    const groups = missing.map((text) => {
      const views = decodedViews(text);
      return { views, inputs: [text, ...views.map((view) => view.text)] };
    });
    const raw = await this.scanner.scan(
      patterns,
      groups.flatMap(({ inputs }) => inputs),
    );
    let next = 0;
    const fresh = groups.map(({ views, inputs }) => ({
      views,
      raw: raw.slice(next, (next += inputs.length)),
      placeholders: inputs.map((input) => this.vault.fakeSpans(input)),
      size,
    }));
    let made = 0;
    return kept.map((known) => known ?? fresh[made++]);
  }

  /** The first rule that matches each real as a whole token. */
  private discovered(inputs: string[], found: Span[][]): Map<string, Rule> {
    const discovered = new Map<string, Rule>();
    for (const [index, spans] of found.entries()) {
      for (const [start, end, pattern] of spans) {
        const rule = this.targets[pattern]?.rule;
        const real = inputs[index].slice(start, end);
        if (
          rule &&
          !splitsToken(inputs[index], start, end) &&
          !discovered.has(real)
        )
          discovered.set(real, rule);
      }
    }
    return discovered;
  }

  private async maskBatch(
    texts: string[],
    restored: readonly string[],
    remember: boolean,
    copies: readonly string[] = [],
  ): Promise<string[]> {
    const restoredReals = [...restored, ...restoredParts(texts, restored)];
    const literals = this.literalReals(restoredReals);
    const patterns = this.targets.map(({ pattern }) => pattern);
    if (literals.length > 0) patterns.push(literalPattern(literals, false));
    if (copies.length > 0) patterns.push(copiesPattern(copies));
    const scanned = await this.scanned(
      texts,
      patterns,
      remember ? this.history : new Map(),
      restoredReals,
    );
    const views = scanned.map((text) => text.views);
    const inputs = [...texts, ...views.flat().map((view) => view.text)];
    const layout = <T>(part: (text: Scanned) => T[]): T[] => [
      ...scanned.map((text) => part(text)[0]),
      ...scanned.flatMap((text) => part(text).slice(1)),
    ];
    const raw = layout((text) => text.raw);
    const placeholders = layout((text) => text.placeholders);
    const found = this.placed(raw, placeholders);
    // Checked on every raw span: the overlap and token filters in `plan` can drop a block span.
    const blocked = found.some((spans) =>
      spans.some(
        ([, , pattern]) => this.targets[pattern]?.rule.strategy === "block",
      ),
    );
    if (blocked) throw new MaskError("BLOCKED", "a block rule matched");
    const discovered = this.discovered(inputs, found);
    const rematched =
      discovered.size > 0
        ? this.placed(
            await this.withLiteral(
              raw,
              patterns.length,
              [...discovered.keys()],
              inputs,
            ),
            placeholders,
          )
        : found;
    const plans = this.plan(texts, views, rematched, discovered);
    const keptReals = new Set(
      plans
        .flatMap((plan) => [
          ...plan.outer,
          ...plan.rewrites.flatMap(({ hits }) => hits),
        ])
        .map(({ real }) => real),
    );
    const avoid = inputs.join("\n");
    const masked = this.vault.atomic(() => {
      const rendered = texts.map((text, index) =>
        this.render(text, plans[index], avoid),
      );
      for (const plan of plans) this.learn(plan.overlapped, keptReals, avoid);
      return rendered;
    });
    if (remember)
      this.history = new Map(
        texts.map((text, index) => [text, scanned[index]]),
      );
    return masked;
  }

  private placed(
    found: Span[][],
    placeholders: [start: number, end: number][][],
  ): Span[][] {
    return found.map((spans, index) =>
      this.withPlaceholders(placeholders[index], spans),
    );
  }

  /**
   * `raw` plus the spans of `reals` as pattern `index`, in the worker's order. The worker scans each
   * pattern on its own, so a rescan of every pattern would return the same `raw` spans.
   */
  private async withLiteral(
    raw: Span[][],
    index: number,
    reals: string[],
    inputs: string[],
  ): Promise<Span[][]> {
    const extra = await this.scanner.scan(
      [literalPattern(reals, false)],
      inputs,
    );
    return raw.map((spans, input) =>
      [
        ...spans,
        ...extra[input].map(([start, end]): Span => [start, end, index]),
      ].sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2]),
    );
  }

  /**
   * Each placeholder stays, so a scanned span inside one is the placeholder itself,
   * and a span that only partly overlaps one is refused.
   */
  private withPlaceholders(
    placeholders: [start: number, end: number][],
    spans: Span[],
  ): Span[] {
    const inside = ([start, end]: Span): boolean =>
      placeholders.some(([from, to]) => from <= start && end <= to);
    const partly = ([start, end]: Span): boolean =>
      placeholders.some(([from, to]) => start < to && from < end);
    if (spans.some((span) => !inside(span) && partly(span)))
      throw new MaskError("BLOCKED", "a match overlaps a placeholder");
    return spans.filter((span) => !inside(span));
  }

  /** The texts of `payload` that `maskPayload` masks, in order. */
  payloadTexts(payload: unknown): string[] {
    return textsOf(payload, (value, map) =>
      mapPayload(value, map, this.format),
    );
  }

  /** Masks `restored` everywhere in `payload`, also when too short to learn. */
  async maskPayload(
    payload: unknown,
    restored: readonly string[] = [],
  ): Promise<unknown> {
    const texts = this.payloadTexts(payload);
    assertPayloadSize(texts);
    const masked = await this.maskBatch(texts, restored, true);
    let next = 0;
    return mapPayload(payload, () => masked[next++], this.format);
  }

  /**
   * Throws HIDDEN_REAL when masked `texts` hold a learned real glued to a word, or match a prefixed
   * token rule. With `transforms`, a reading of them counts too: spaced out, wrapped, reversed or encoded.
   */
  async assertNoHiddenReal(texts: string[], transforms = true): Promise<void> {
    if (await this.hidesReal(texts, transforms))
      throw new MaskError(
        "HIDDEN_REAL",
        "a secret is spaced out, wrapped, reversed or encoded",
      );
  }

  /**
   * The tool results of a masked payload that `assertNoHiddenReal` refuses. Each payload resends the
   * history, so a text of a result of the last payload that passed is checked again only once the vault has grown.
   */
  async hidingResults(
    results: readonly unknown[],
    transforms: boolean,
  ): Promise<Set<unknown>> {
    const size = this.vault.entries().length;
    const hiding = new Set<unknown>();
    const passed = new Map<string, number>();
    for (const result of results) {
      const texts = this.payloadTexts(result);
      const fresh = texts.filter(
        (text) => this.resultsChecked.get(text) !== size,
      );
      if (fresh.length > 0 && (await this.hidesReal(fresh, transforms)))
        hiding.add(result);
      else for (const text of texts) passed.set(text, size);
    }
    this.resultsChecked = passed;
    return hiding;
  }

  private async hidesReal(
    texts: string[],
    transforms: boolean,
  ): Promise<boolean> {
    const readings = texts.map((text) =>
      transforms ? hiddenReadings(text, this.neutral) : [this.neutral(text)],
    );
    const flat = readings.flat();
    const unwrapped = transforms
      ? flat.map((reading) => reading.replace(WRAP, ""))
      : [];
    return (
      this.hidesLearnedReal(texts, readings, transforms) ||
      (await this.hidesPrefixedToken([...flat, ...unwrapped]))
    );
  }

  /**
   * `assertNoHiddenReal` without transforms for the texts of a payload. Each payload repeats the history,
   * so a text of the last payload that passed is not checked again, unless a vault entry added since
   * its check occurs in it. A real with NUL can match the NUL that hides a fake, so it rechecks every text.
   */
  async assertNoHiddenRealInPayload(texts: string[]): Promise<void> {
    const entries = this.vault.entries();
    const fresh = texts.filter((text) => {
      const size = this.checked.get(text);
      return (
        size === undefined ||
        entries
          .slice(size)
          .some(
            ([real, fake]) =>
              real.includes("\0") || text.includes(real) || text.includes(fake),
          )
      );
    });
    await this.assertNoHiddenReal(fresh, false);
    this.checked = new Map(texts.map((text) => [text, entries.length]));
  }

  /**
   * A fake in its context, such as `admin:` before it, can complete a token rule. A fake under 4
   * characters stays: it also matches single characters of a spaced-out value. The rest of a fixed
   * fake around its template stays, so the glued check sees a learned real in it.
   */
  private readonly neutral = (text: string): string => {
    let out = "";
    let last = 0;
    for (const [from, to] of this.vault.fakeSpans(text)) {
      if (to - from < 4) continue;
      const fake = text.slice(from, to);
      const fixed = this.fixedFakes
        .map((pattern) => pattern.exec(fake))
        .find((match) => match !== null);
      const start = from + (fixed?.[1].length ?? 0);
      const end = to - (fixed?.[3].length ?? 0);
      out += text.slice(last, start) + "\0".repeat(end - start);
      last = end;
    }
    return out + text.slice(last);
  };

  /** Transformed readings match by chance on short values, so values under 8 characters get only the plain check. */
  private hidesLearnedReal(
    texts: string[],
    readings: string[][],
    transforms: boolean,
  ): boolean {
    const length = (real: string) => real.replace(/\s+/g, "").length;
    const long = [...this.literalReals([]), ...this.known].filter(
      (real) => length(real) >= MIN_LEARNED_LENGTH,
    );
    const short = this.known.filter(
      (real) =>
        length(real) >= MIN_GLUED_KNOWN_LENGTH &&
        length(real) < MIN_LEARNED_LENGTH,
    );
    const plain = transforms
      ? texts.map((text) => [this.neutral(text)])
      : readings;
    return (
      this.hidesGlued(texts, readings, transforms, long) ||
      this.hidesGlued(texts, plain, false, short)
    );
  }

  private hidesGlued(
    texts: string[],
    readings: string[][],
    transforms: boolean,
    reals: string[],
  ): boolean {
    const views = transforms ? glueViews(readings) : undefined;
    return reals.some((real) => {
      if (this.identity.has(real)) return false;
      const bare = real.replace(/\s+/g, "");
      // A word in another case or split by a space is ordinary text, and so is a run of digits
      // inside a longer token. A plain copy that masking left is glued to a word.
      const fold = /\d/.test(bare);
      const token = /\p{L}/u.test(bare) && /[^\p{L}]/u.test(bare);
      const needle = !transforms ? real : fold ? bare.toLowerCase() : bare;
      const view =
        views === undefined
          ? readings
          : fold
            ? views.folded
            : token
              ? views.joined
              : views.unwrapped;
      return view.some(
        (list, index) =>
          (token || !texts[index].includes(bare)) &&
          list.some((reading) => reading.includes(needle)),
      );
    });
  }

  /**
   * Catches a secret that the session has not learned yet. Only prefixed gitleaks rules run: keyed,
   * generic and PII rules match decoded noise in ordinary output. A keyed gitleaks rule starts with
   * its context, such as `etsy` that reversed `SystemPrompt` spells.
   */
  private async hidesPrefixedToken(readings: string[]): Promise<boolean> {
    const targets = this.targets.filter(
      ({ rule }) =>
        rule.id.startsWith("gitleaks.") &&
        rule.id !== "gitleaks.generic-api-key" &&
        !(rule.type === "regex" && rule.pattern.startsWith("[\\w.-]{0,50}?")),
    );
    const spans = await this.scanner.scan(
      targets.map(({ pattern }) => pattern),
      readings,
    );
    return spans.some((list) => list.length > 0);
  }

  /** `restored` collects each real that this restore puts back. */
  restoreValue(value: unknown, restored = new Set<string>()): unknown {
    if (typeof value === "string") return this.restoreText(value, restored);
    if (typeof value === "number") return this.restoreNumber(value, restored);
    if (Array.isArray(value))
      return value.map((item) => this.restoreValue(item, restored));
    if (isRecord(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.restoreValue(item, restored),
        ]),
      );
    return value;
  }

  /**
   * A fixed fake never parents a part: its template word, such as `REDACTED`, would restore a slice of its real.
   */
  private readonly mayParent = (fake: string): boolean =>
    !this.fixedFakes.some((pattern) => pattern.test(fake));

  /**
   * Restores plain text, each distinct span of `partSpans` that is part of one fake, and the decoded text
   * of each encoded run, which is re-encoded.
   * A fake that overlaps an encoded run wins, since the run is then only part of the fake.
   */
  private restoreText(text: string, restored: Set<string>): string {
    const fakes = this.vault.fakeSpans(text);
    const edits: Edit[] = fakes.map(([start, end]) => ({
      start,
      end,
      text: this.restoreFake(text.slice(start, end), restored),
    }));
    for (const [start, end] of partSpans(text)) {
      const piece = text.slice(start, end);
      if (
        !isDistinctPart(piece) ||
        fakes.some(([from, to]) => from < end && start < to)
      )
        continue;
      const part = this.vault.realOfPart(piece, this.mayParent);
      if (part === undefined) continue;
      fakes.push([start, end]);
      restored.add(part);
      edits.push({ start, end, text: part });
    }
    for (const view of decodedViews(text)) {
      if (fakes.some(([start, end]) => start < view.end && view.start < end))
        continue;
      edits.push({
        start: view.start,
        end: view.end,
        text: this.restoreRun(text.slice(view.start, view.end), view, restored),
      });
    }
    return splice(text, edits);
  }

  /**
   * Restores a whole fake. A bound fake is an encoded run whose real is put back as written,
   * so a real that its decoded text restores is put back too, but only when the restored real
   * holds that real as text or decoded: a fake's decoded fake that the real does not echo is not put back.
   */
  private restoreFake(fake: string, restored: Set<string>): string {
    const real = this.vault.restore(fake, restored);
    const echoed = [real, ...decodedViews(real).map((view) => view.text)];
    const leaves = new Set<string>();
    for (const view of decodedViews(fake))
      this.vault.restore(view.text, leaves);
    for (const leaf of leaves)
      if (echoed.some((text) => text.includes(leaf))) restored.add(leaf);
    return real;
  }

  /**
   * A run that is exactly a fake restores as text, since a fake can also decode.
   * A restored text of another length cannot be re-encoded in place, so the run stays as written.
   */
  private restoreRun(run: string, view: View, restored: Set<string>): string {
    if (this.vault.realOf(run) !== undefined)
      return this.restoreFake(run, restored);
    const inner = new Set<string>();
    const restoredText = this.vault.restore(view.text, inner);
    if (restoredText === view.text || restoredText.length !== view.text.length)
      return run;
    for (const value of inner) restored.add(value);
    return view.encode(restoredText);
  }

  /** A number restores only when its decimal text is exactly a fake whose real is the same number. */
  private restoreNumber(value: number, restored: Set<string>): number {
    const real = this.vault.realOf(String(value));
    if (real === undefined || String(Number(real)) !== real) return value;
    restored.add(real);
    return Number(real);
  }

  /** An encoded run with inner spans is rewritten as a whole, so outer spans that overlap it are dropped. */
  private plan(
    texts: string[],
    views: View[][],
    found: Span[][],
    discovered: ReadonlyMap<string, Rule>,
  ): TextPlan[] {
    let next = texts.length;
    return texts.map((text, index) => {
      const rewrites: Rewrite[] = [];
      const overlapped: Hit[] = [];
      for (const view of views[index]) {
        const hits = this.hitsIn(view.text, found[next++], discovered);
        for (const hit of hits.kept) assertShapeInRun(hit);
        overlapped.push(...hits.overlapped);
        if (hits.kept.length > 0) rewrites.push({ view, hits: hits.kept });
      }
      const outer = found[index].filter(
        ([start, end]) =>
          !rewrites.some(({ view }) => start < view.end && view.start < end),
      );
      const hits = this.hitsIn(text, outer, discovered);
      return {
        outer: hits.kept,
        rewrites,
        overlapped: [...overlapped, ...hits.overlapped],
      };
    });
  }

  private hitsIn(
    text: string,
    spans: Span[],
    discovered: ReadonlyMap<string, Rule>,
  ): { kept: Hit[]; overlapped: Hit[] } {
    // The rule comes from the span before an extension: the extended real is no `discovered` key.
    const ruleOf = ([start, end, pattern]: Span): Rule | undefined =>
      this.targets[pattern]?.rule ?? discovered.get(text.slice(start, end));
    const toHit = (span: Span, end: number): Hit => {
      const start = span[0];
      const real = text.slice(start, end);
      const rule = ruleOf(span);
      const others = (): Span[] =>
        spans.filter((other) => ruleOf(other) !== rule);
      return {
        start,
        end,
        real,
        rule,
        name: this.nameOf(rule, real, start, others),
      };
    };
    const split = keptSpans(text, spans);
    return {
      kept: split.kept.map(({ span, end }) => toHit(span, end)),
      overlapped: split.overlapped.map((span) => toHit(span, span[1])),
    };
  }

  /**
   * The `name` group of a fixed regex match: its fake keeps the rest of the match in clear.
   * The whole match when the rest holds a digit, a configured value or a span of another rule, so
   * the rest carries no secret: a configured value glued to a word gives no span. None without the
   * group. `assertNoHiddenReal` sees a learned real in the rest, see `neutral`.
   */
  private nameOf(
    rule: Rule | undefined,
    real: string,
    start: number,
    others: () => Span[],
  ): [start: number, end: number] | undefined {
    if (rule?.type !== "regex" || rule.strategy !== "fixed") return undefined;
    const name = new RegExp(`^(?:${rule.pattern})$`, `${rule.flags}d`).exec(
      real,
    )?.indices?.groups?.name;
    if (!name) return undefined;
    return this.restIsClear(real, name, start, others)
      ? name
      : [0, real.length];
  }

  private restIsClear(
    real: string,
    [first, last]: [start: number, end: number],
    start: number,
    others: () => Span[],
  ): boolean {
    const rests = [real.slice(0, first), real.slice(last)];
    // A digit would glue to the number of the fake, and the hidden-copy check misses a learned real
    // with digits in the rest.
    if (rests.some((rest) => /\d/.test(rest))) return false;
    const end = start + real.length;
    const inRest = ([from, to]: Span): boolean =>
      (from < start + first && start < to) || (from < end && start + last < to);
    return (
      !this.known.some((value) => rests.some((rest) => rest.includes(value))) &&
      !others().some(inRest)
    );
  }

  private render(text: string, plan: TextPlan, avoid: string): string {
    const runs = plan.rewrites.map(({ view, hits }) => {
      const decoded = splice(view.text, this.edits(hits, avoid));
      if (decoded.length !== view.text.length)
        throw new MaskError(
          "BLOCKED",
          "a learned value whose fake has another length matched inside an encoded run and cannot be re-encoded",
        );
      const rendered = view.encode(decoded);
      this.vault.bindRun(text.slice(view.start, view.end), rendered, avoid);
      return { start: view.start, end: view.end, text: rendered };
    });
    return splice(text, [...runs, ...this.edits(plan.outer, avoid)]);
  }

  /** Preserve the winning rule's no-storage policy while learning distinct covered secrets. */
  private learn(
    hits: Hit[],
    keptReals: ReadonlySet<string>,
    avoid: string,
  ): void {
    for (const hit of hits)
      if (hit.rule && !keptReals.has(hit.real)) this.replacement(hit, avoid);
  }

  private edits(hits: Hit[], avoid: string): Edit[] {
    return hits.map((hit) => ({
      start: hit.start,
      end: hit.end,
      text: this.replacement(hit, avoid),
    }));
  }

  private replacement(hit: Hit, avoid: string): string {
    if (hit.rule?.strategy === "mask")
      return hit.rule.replacement ?? DEFAULT_MASK;
    if (hit.rule?.strategy === "fixed")
      return this.vault.fixedFor(
        hit.real,
        fixedReplacement(hit.rule),
        avoid,
        hit.name,
      );
    return this.vault.partFor(
      hit.real,
      avoid,
      this.mayParent,
      hit.rule?.strategy === "shape",
    );
  }
}
