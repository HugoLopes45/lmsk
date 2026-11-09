/** Returns `size` random bytes. `crypto.randomBytes` fits. */
export type RandomBytes = (size: number) => Uint8Array;

/** Uniform integer in [0, bound), bound <= 256. */
function below(bound: number, random: RandomBytes): number {
  const limit = 256 - (256 % bound);
  for (;;) {
    const [byte] = random(1);
    if (byte !== undefined && byte < limit) return byte % bound;
  }
}

const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";

function pick(alphabet: string, random: RandomBytes): string {
  return alphabet.charAt(below(alphabet.length, random));
}

/** Hex only, with at least one digit: `face` stays a word, `3f2b` stays hex. */
const HEX = /^(?=.*\d)[0-9a-fA-F:-]+$/;

/**
 * Replace each letter and digit with a random one of the same class and keep
 * every other character. A digit run keeps whether it starts with zero, so
 * numbers stay numbers of the same width.
 */
function alphabet(
  char: string,
  hex: boolean,
  previousDigit: boolean,
): string | undefined {
  if (/\p{N}/u.test(char)) {
    if (previousDigit) return DIGITS;
    return char === "0" ? undefined : DIGITS.slice(1);
  }
  if (!/\p{L}/u.test(char)) return undefined;
  const upper = char === char.toUpperCase();
  if (hex) return upper ? "ABCDEF" : "abcdef";
  return upper ? UPPER : LOWER;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Same width, and 255 at most: 3 digits give 100-255, 2 give 10-99, 1 keeps a 0. */
function octet(width: number, zero: boolean, random: RandomBytes): string {
  if (width === 3) return String(100 + below(156, random));
  if (width === 2) return String(10 + below(90, random));
  return zero ? "0" : String(1 + below(9, random));
}

export function reshape(value: string, random: RandomBytes): string {
  if (IPV4.test(value))
    return value
      .split(".")
      .map((part) => octet(part.length, part === "0", random))
      .join(".");
  const hex = HEX.test(value);
  let out = "";
  let previousDigit = false;
  for (const char of value) {
    const set = alphabet(char, hex, previousDigit);
    out += set
      ? Array.from({ length: char.length }, () => pick(set, random)).join("")
      : char;
    previousDigit = /\p{N}/u.test(char);
  }
  return out;
}
