import { CodedError } from "./errors.ts";
import { escapeRegex } from "./scanner.ts";
import { type RandomBytes, reshape } from "./shape.ts";

export type VaultCode = "VAULT_FULL" | "VAULT_COLLISION";

export class VaultError extends CodedError<VaultCode> {}

/** `[real, fake]`. */
export type VaultEntry = [real: string, fake: string];

const MAX_ENTRIES = 50000;
const MAX_ATTEMPTS = 64;

/** Equal, or one contains the other. */
function nested(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

const ALNUM = /[A-Za-z0-9]/;

export const MIN_LEARNED_LENGTH = 8;

/** A token with a digit and a letter, or a capital after a small letter: unlike a word or a number, it rarely occurs by chance. */
const RANDOM_LOOKING = /\p{N}.*\p{L}|\p{L}.*\p{N}|\p{Ll}.*\p{Lu}/u;

/** A part of a real that is rarely a word or number by chance, so matching it outside its real is safe. */
export function isDistinctPart(token: string): boolean {
  return (
    token.length >= 4 &&
    (token.length >= MIN_LEARNED_LENGTH || RANDOM_LOOKING.test(token))
  );
}

/**
 * Opaque letters and digits whose first and last four characters are a distinct part,
 * so that the slice the model takes of either end restores.
 */
function sliceable(length: number, random: RandomBytes): string {
  for (;;) {
    const fake = opaque(length, random);
    if (
      length < MIN_LEARNED_LENGTH ||
      (isDistinctPart(fake.slice(0, 4)) && isDistinctPart(fake.slice(-4)))
    )
      return fake;
  }
}

/** Whether `fake` has the length of `real` and each of its other characters where `real` has it. */
function aligned(real: string, fake: string): boolean {
  if (real.length !== fake.length) return false;
  for (let index = 0; index < fake.length; index++)
    if (
      !ALNUM.test(fake.charAt(index)) &&
      fake.charAt(index) !== real.charAt(index)
    )
      return false;
  return true;
}
const SHORT_WORD = /^\p{L}{2,4}$/u;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const OPAQUE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** The largest multiple of 62 that fits in a byte. Bytes from here up are rejected, so each character is equally likely. */
const OPAQUE_LIMIT = 248;

/** `length` random letters and digits. */
function opaque(length: number, random: RandomBytes): string {
  let out = "";
  while (out.length < length)
    for (const byte of random(length - out.length))
      if (byte < OPAQUE_LIMIT && out.length < length)
        out += OPAQUE_ALPHABET.charAt(byte % OPAQUE_ALPHABET.length);
  return out;
}

/** Whether the character at `index` is a letter or digit; outside the text it is not. */
function isWord(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

/** Whether `fake` occurs in `text` where `restore` would replace it. */
function occurs(text: string, fake: string): boolean {
  for (
    let start = text.indexOf(fake);
    start >= 0;
    start = text.indexOf(fake, start + 1)
  ) {
    const end = start + fake.length;
    if (
      !(isWord(text, start) && isWord(text, start - 1)) &&
      !(isWord(text, end - 1) && isWord(text, end))
    )
      return true;
  }
  return false;
}

/**
 * The fakes of a fixed template in each case that `styled` writes, see `Vault.fixedFor`. With
 * `rests`, group 1 and group 3 are the rest of the match around the name. Group 2 is the number.
 */
export function fixedFakePattern(replacement: string, rests: boolean): RegExp {
  const at = replacement.indexOf("{n}");
  const cases = (text: string): string =>
    `(?:${[text, text.toUpperCase(), text.toLowerCase()].map(escapeRegex).join("|")})`;
  return new RegExp(
    `^(${rests ? ".*?" : ""})${cases(replacement.slice(0, at))}[^\\p{L}\\p{N}]?(\\d+)${cases(replacement.slice(at + 3))}(${rests ? ".*" : ""})$`,
    "su",
  );
}

/** The letters and digits of a name in small letters, which all its variants share. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The template with `number`, in the case of `name`. The first sign of `name` goes before the number,
 * so `Acme Corp` and `AcmeCorp` get two fakes with one number.
 */
function styled(replacement: string, name: string, number: number): string {
  const at = replacement.indexOf("{n}");
  const sign = ALNUM.test(replacement.charAt(at - 1))
    ? (/[^\p{L}\p{N}]/u.exec(name)?.[0] ?? "")
    : "";
  const text =
    replacement.slice(0, at) + sign + number + replacement.slice(at + 3);
  const upper = /\p{Lu}/u.test(name);
  const lower = /\p{Ll}/u.test(name);
  if (upper && !lower) return text.toUpperCase();
  return lower && !upper ? text.toLowerCase() : text;
}

/** `[fake, real]` pairs grouped by the fake's first character, longest fake first. */
function bucketsOf(
  pairs: Iterable<[fake: string, real: string]>,
): Map<string, [fake: string, real: string][]> {
  const buckets = new Map<string, [fake: string, real: string][]>();
  const found = [...pairs].filter(([fake]) => fake.length > 0);
  for (const pair of found.sort((a, b) => b[0].length - a[0].length)) {
    const key = pair[0].charAt(0);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(pair);
    else buckets.set(key, [pair]);
  }
  return buckets;
}

/**
 * Maps reals to fakes and back. A fake never contains or equals another
 * string in the vault, except where `usable` exempts it, and `restore` matches
 * only whole tokens.
 */
export class Vault {
  private readonly random: RandomBytes;
  private readonly fakes = new Map<string, string>();
  private readonly reals = new Map<string, string>();
  /** Fakes from `bucketsOf`; undefined until the next store. */
  private buckets: Map<string, [fake: string, real: string][]> | undefined;

  constructor(random: RandomBytes, entries: VaultEntry[] = []) {
    this.random = random;
    for (const [real, fake] of entries) {
      this.room();
      if (
        !real ||
        !fake ||
        real === fake ||
        this.fakes.has(real) ||
        this.reals.has(fake)
      )
        throw new VaultError("VAULT_COLLISION", "invalid restored mapping");
      this.fakes.set(real, fake);
      this.reals.set(fake, real);
    }
  }

  /**
   * Opaque fake of the same length: letters and digits, and the `@` of an email in place,
   * so that it still reads as one and its domain is a slice of the fake.
   */
  fakeFor(real: string, avoid: string): string {
    const pieces = EMAIL_SHAPE.test(real) ? real.split("@") : [real];
    return this.assign(real, avoid, () =>
      pieces.map((piece) => sliceable(piece.length, this.random)).join("@"),
    );
  }

  /** Same class per character, see `reshape`. A shape rule keeps the form of its real. */
  shapeFor(real: string, avoid: string): string {
    return this.assign(real, avoid, () => this.shaped(real));
  }

  /**
   * `reshape` turns a real of 2 to 4 letters into a short word, such as `cat`. The model may write
   * that word, which would then restore to the real, so such a real gets a fake with a digit.
   */
  private shaped(real: string): string {
    if (!SHORT_WORD.test(real)) return reshape(real, this.random);
    for (;;) {
      const fake = opaque(real.length, this.random);
      if (!SHORT_WORD.test(fake)) return fake;
    }
  }

  /**
   * For a part of a known real, the same part of its fake, so that a slice the model takes
   * of the fake matches the slice a command takes of the real.
   * This fake nests in its parent fake: `restore` still matches the longer fake first.
   * `shape` marks a part of a shape rule: with no parent, or as a short word, it gets its fake from `shaped`.
   */
  partFor(
    part: string,
    avoid: string,
    mayParent: (fake: string) => boolean,
    shape: boolean,
  ): string {
    const parent =
      shape && SHORT_WORD.test(part)
        ? undefined
        : this.parentOf(part, (real) => real, mayParent);
    if (parent === undefined)
      return shape ? this.shapeFor(part, avoid) : this.fakeFor(part, avoid);
    const [, fake, start] = parent;
    const slice = fake.slice(start, start + part.length);
    return this.assign(
      part,
      avoid,
      (attempt) => (attempt === 0 ? slice : opaque(part.length, this.random)),
      (known) => known === fake,
    );
  }

  /** The part of a real at the place where `part` occurs in its fake, see `parentOf`. */
  realOfPart(
    part: string,
    mayParent: (fake: string) => boolean,
  ): string | undefined {
    const parent = this.parentOf(part, (_real, fake) => fake, mayParent);
    if (parent === undefined) return undefined;
    const [real, , start] = parent;
    return real.slice(start, start + part.length);
  }

  /**
   * The one entry whose `held` side starts or ends with `part`, and whose fake keeps the
   * real's length and punctuation. A command takes a head or a tail; a middle slice would
   * mostly match a word the model wrote by chance. `mayParent` excludes fakes that must not
   * parent a part, such as a fixed template.
   */
  private parentOf(
    part: string,
    held: (real: string, fake: string) => string,
    mayParent: (fake: string) => boolean,
  ): [real: string, fake: string, start: number] | undefined {
    const parents: [string, string, number][] = [];
    for (const [real, fake] of this.fakes) {
      const text = held(real, fake);
      if (text.length <= part.length || !mayParent(fake)) continue;
      const start = text.startsWith(part)
        ? 0
        : text.endsWith(part)
          ? text.length - part.length
          : -1;
      if (start >= 0 && aligned(real, fake)) parents.push([real, fake, start]);
    }
    return parents.length === 1 ? parents[0] : undefined;
  }

  /**
   * `{n}` in the replacement becomes the number of the name: the slice `name` of `real`, else
   * all of `real`. With `name`, the fakes of the template can hold a rest. The variants of one
   * name share its number: another case, other signs between its letters, or a longer word around
   * it. The fake keeps the case, the first sign and the rest of the word of its real, so that it
   * restores to exactly that real.
   * Fakes of one template nest, as `Client1` in `Client1Theme`: `restore` matches whole tokens.
   */
  fixedFor(
    real: string,
    replacement: string,
    avoid: string,
    name?: [start: number, end: number],
  ): string {
    // Without this, every hit of a known real scans the whole vault in `numberOf`.
    const existing = this.fakes.get(real);
    if (existing !== undefined) return existing;
    const [start, end] = name ?? [0, real.length];
    const family = fixedFakePattern(replacement, name !== undefined);
    const [own, next] = this.numberOf(nameKey(real.slice(start, end)), family);
    const after = own === undefined ? next : next - 1;
    return this.assign(
      real,
      avoid,
      (attempt) =>
        real.slice(0, start) +
        styled(
          replacement,
          real.slice(start, end),
          attempt === 0 ? (own ?? next) : after + attempt,
        ) +
        real.slice(end),
      (known) => family.test(known),
    );
  }

  /** The number of the name with `key` among the fakes of `family`, and the next free number. */
  private numberOf(
    key: string,
    family: RegExp,
  ): [own: number | undefined, next: number] {
    let own: number | undefined;
    let next = 1;
    for (const [real, fake] of this.fakes) {
      const match = family.exec(fake);
      if (!match) continue;
      const number = Number(match[2]);
      next = Math.max(next, number + 1);
      const name = real.slice(match[1].length, real.length - match[3].length);
      if (own === undefined && nameKey(name) === key) own = number;
    }
    return [own, next];
  }

  /** Replaces each fake in `text` with its real. `restored` collects the reals that replaced one. */
  restore(text: string, restored?: Set<string>): string {
    let out = "";
    let last = 0;
    for (const [start, end, real] of this.fakeMatches(text)) {
      out += text.slice(last, start) + real;
      restored?.add(real);
      last = end;
    }
    return out + text.slice(last);
  }

  /** Start and end of each fake that `restore` replaces in `text`. */
  fakeSpans(text: string): [start: number, end: number][] {
    return this.fakeMatches(text).map(([start, end]) => [start, end]);
  }

  /**
   * Each fake that `restore` replaces, left to right, with its real. Matched
   * by bucket, not by one alternation over every fake: V8 cannot run a regex
   * that large.
   */
  private fakeMatches(
    text: string,
  ): [start: number, end: number, real: string][] {
    if (this.reals.size === 0) return [];
    const buckets = (this.buckets ??= bucketsOf(this.reals));
    const matches: [start: number, end: number, real: string][] = [];
    let start = 0;
    while (start < text.length) {
      const hit = this.fakeAt(text, start, buckets);
      if (hit === undefined) {
        // No fake starts inside a run of letters and digits.
        if (isWord(text, start)) while (isWord(text, start + 1)) start++;
        start++;
        continue;
      }
      matches.push([start, hit[0], hit[1]]);
      start = hit[0];
    }
    return matches;
  }

  /** The end and real of the longest bounded fake that starts at `start`. */
  private fakeAt(
    text: string,
    start: number,
    buckets: Map<string, [fake: string, real: string][]>,
  ): [end: number, real: string] | undefined {
    if (isWord(text, start) && isWord(text, start - 1)) return undefined;
    for (const [fake, real] of buckets.get(text.charAt(start)) ?? []) {
      const end = start + fake.length;
      if (
        end <= text.length &&
        text.startsWith(fake, start) &&
        !(isWord(text, end - 1) && isWord(text, end))
      )
        return [end, real];
    }
    return undefined;
  }

  /**
   * Maps an encoded run to the run it renders as. The run is the key because a
   * percent escape with no hex letter cannot carry the case of the original.
   */
  bindRun(run: string, rendered: string, avoid: string): void {
    const existing = this.fakes.get(run);
    if (existing === rendered) return;
    this.room();
    if (
      existing !== undefined ||
      !this.usable(run, rendered, avoid, (known) => rendered.includes(known))
    )
      throw new VaultError("VAULT_COLLISION", "encoded run has no unused fake");
    this.store(run, rendered);
  }

  /** The real behind a fake, or undefined when the text is no fake. */
  realOf(fake: string): string | undefined {
    return this.reals.get(fake);
  }

  entries(): VaultEntry[] {
    return [...this.fakes];
  }

  atomic(render: () => string[]): string[] {
    const size = this.fakes.size;
    const buckets = this.buckets;
    try {
      return render();
    } catch (error) {
      for (const [real, fake] of [...this.fakes].slice(size)) {
        this.fakes.delete(real);
        this.reals.delete(fake);
      }
      this.buckets = buckets;
      throw error;
    }
  }

  private assign(
    real: string,
    avoid: string,
    candidate: (attempt: number) => string,
    exempt?: (knownFake: string) => boolean,
  ): string {
    const existing = this.fakes.get(real);
    if (existing !== undefined) return existing;
    this.room();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const fake = candidate(attempt);
      if (this.usable(real, fake, avoid, exempt)) {
        this.store(real, fake);
        return fake;
      }
    }
    throw new VaultError(
      "VAULT_COLLISION",
      `no unused fake in ${MAX_ATTEMPTS} attempts`,
    );
  }

  private room(): void {
    if (this.fakes.size >= MAX_ENTRIES)
      throw new VaultError("VAULT_FULL", `more than ${MAX_ENTRIES} entries`);
  }

  private store(real: string, fake: string): void {
    this.fakes.set(real, fake);
    this.reals.set(fake, real);
    this.buckets = undefined;
  }

  /**
   * A fake must not nest with any string in the vault, and must not occur in the text it hides.
   * `exempt` lifts this for a known fake that nests by design: a part's fake in its parent fake
   * (`partFor`), the fakes in an encoded run's fake (`bindRun`), and fakes of one fixed template
   * (`fixedFor`). An equal fake is never exempt.
   */
  private usable(
    real: string,
    fake: string,
    avoid: string,
    exempt: (knownFake: string) => boolean = () => false,
  ): boolean {
    if (nested(real, fake) || occurs(avoid, fake)) return false;
    for (const [known, knownFake] of this.fakes)
      if (
        nested(known, fake) ||
        knownFake === fake ||
        (!exempt(knownFake) && nested(knownFake, fake))
      )
        return false;
    return true;
  }
}
