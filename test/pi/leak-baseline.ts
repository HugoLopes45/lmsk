import { createHash } from "node:crypto";
import {
  envValues,
  keyedPattern,
  literalPattern,
  mergeConfigs,
  type RawConfig,
  type Rule,
  type Scanner,
  type ScanPattern,
  validateConfig,
} from "../../src/core/index.ts";

export const CLASS_IDS = [
  "C01",
  "C02",
  "C03",
  "C04",
  "C05",
  "C06",
  "C07",
  "C08",
  "C09",
  "C10",
  "C11",
  "C12",
  "C13",
] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export interface CanaryClass {
  id: ClassId;
  name: string;
  /** Rule id expected to detect the canary value. */
  expectedRule: string;
  /** Surrounding text. `{v}` is replaced by the canary value. */
  template: string;
  value: string;
}

/** Env rule variable. The test sets it on process.env and restores it afterwards. */
export const ENV_VAR_NAME = "PMS_LEAK_ENV_VALUE";

/** Literal rule id, configured by the measurement only. */
export const LITERAL_RULE_ID = "leak-literal";
export const ENV_RULE_ID = "leak-env";

function hexOf(label: string, bytes: number): string {
  let out = "";
  for (let counter = 0; out.length < bytes * 2; counter++)
    out += createHash("sha256")
      .update(`pms-leak-baseline/v1/${label}/${counter}`)
      .digest("hex");
  return out.slice(0, bytes * 2);
}

/** Decimal digits derived from a label. Each call with the same label gives the same digits. */
function digitsOf(label: string, count: number): string {
  const hex = hexOf(label, count);
  return [...hex]
    .slice(0, count)
    .map((char) => String(parseInt(char, 16) % 10))
    .join("");
}

function alnumOf(label: string, count: number): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return [...hexOf(label, count * 2)]
    .reduce<string[]>((acc, char, index) => {
      if (index % 2 === 0) acc.push(char);
      else acc[acc.length - 1] += char;
      return acc;
    }, [])
    .map((pair) => alphabet[parseInt(pair, 16) % alphabet.length])
    .join("")
    .slice(0, count);
}

function luhnCheckDigit(payload: string): number {
  let sum = 0;
  [...payload].reverse().forEach((char, index) => {
    const doubled = index % 2 === 0 ? Number(char) * 2 : Number(char);
    sum += doubled > 9 ? doubled - 9 : doubled;
  });
  return (10 - (sum % 10)) % 10;
}

/** ISO 13616 check digits: the rearranged number, with letters as 10 to 35, leaves remainder 1 after the check. */
function ibanCheckDigits(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`;
  let remainder = 0;
  for (const char of rearranged)
    for (const digit of String(parseInt(char, 36)))
      remainder = (remainder * 10 + Number(digit)) % 97;
  return String(98 - remainder).padStart(2, "0");
}

/** French NIR: 13 digit body, then a key of 97 minus the body modulo 97. */
function nirKey(body: string): string {
  return String(97 - (Number(body) % 97)).padStart(2, "0");
}

/** Synthetic values built from detector formats. Each one passes its own validator. */
export function buildCanaries(): CanaryClass[] {
  const iban = `FR${ibanCheckDigits("FR", digitsOf("C06", 23))}${digitsOf("C06", 23)}`;
  const cardPayload = `4${digitsOf("C07", 14)}`;
  const nirBody = `1${digitsOf("C08a", 2)}12${digitsOf("C08b", 2)}${digitsOf("C08c", 3)}${digitsOf("C08d", 3)}`;
  const nirBodyFull = nirBody.slice(0, 13);
  const nir = `${nirBodyFull[0]} ${nirBodyFull.slice(1, 3)} ${nirBodyFull.slice(3, 5)} ${nirBodyFull.slice(5, 7)} ${nirBodyFull.slice(7, 10)} ${nirBodyFull.slice(10, 13)} ${nirKey(nirBodyFull)}`;
  const ssnArea = 100 + (Number(digitsOf("C09a", 3)) % 800);
  const ssnAreaSafe = ssnArea === 666 ? 667 : ssnArea;
  const ssnGroup = 1 + (Number(digitsOf("C09b", 2)) % 99);
  const ssnSerial = 1 + (Number(digitsOf("C09c", 4)) % 9999);
  const uuidHex = hexOf("C11", 16);
  const values: Record<ClassId, string> = {
    C01: `ghp_${alnumOf("C01", 36)}`,
    C02: alnumOf("C02", 16),
    C03: alnumOf("C03", 16),
    C04: `pms${hexOf("C04", 5)}@leak.example.test`,
    C05: `06 ${digitsOf("C05a", 2)} ${digitsOf("C05b", 2)} ${digitsOf("C05c", 2)} ${digitsOf("C05d", 2)}`,
    C06: iban,
    C07: `${cardPayload}${luhnCheckDigit(cardPayload)}`,
    C08: nir,
    C09: `${String(ssnAreaSafe).padStart(3, "0")}-${String(ssnGroup).padStart(2, "0")}-${String(ssnSerial).padStart(4, "0")}`,
    C10: `203.0.113.${2 + (Number(digitsOf("C10", 3)) % 253)}`,
    C11: [
      uuidHex.slice(0, 8),
      uuidHex.slice(8, 12),
      uuidHex.slice(12, 16),
      uuidHex.slice(16, 20),
      uuidHex.slice(20, 32),
    ].join("-"),
    C12: `pms-lit-${alnumOf("C12", 10)}`,
    C13: `pmsenv${alnumOf("C13", 12)}`,
  };
  const templates: Record<ClassId, string> = {
    C01: "{v}",
    C02: 'api_key: "{v}"',
    C03: "postgres://pmsuser:{v}@db.example.test:5432/app",
    C04: "{v}",
    C05: "{v}",
    C06: "{v}",
    C07: "{v}",
    C08: "{v}",
    C09: "{v}",
    C10: "{v}",
    C11: "{v}",
    C12: "{v}",
    C13: "{v}",
  };
  const names: Record<ClassId, [string, string]> = {
    C01: ["vendor-key", "gitleaks.github-pat"],
    C02: ["keyed-secret", "keyed-secret"],
    C03: ["url-password", "connection-password"],
    C04: ["email", "email"],
    C05: ["phone", "phone-fr"],
    C06: ["iban", "iban"],
    C07: ["card", "credit-card"],
    C08: ["nir", "fr-nir"],
    C09: ["ssn", "us-ssn"],
    C10: ["ip", "ipv4"],
    C11: ["uuid", "uuid"],
    C12: ["literal", LITERAL_RULE_ID],
    C13: ["env-rule", ENV_RULE_ID],
  };
  const seen = new Set<string>();
  return CLASS_IDS.map((id) => {
    const value = values[id];
    if (seen.has(value)) throw new Error(`duplicate canary value for ${id}`);
    seen.add(value);
    const [name, expectedRule] = names[id];
    return { id, name, expectedRule, template: templates[id], value };
  });
}

/** Full text of one canary as it appears in a prompt, file or tool output. */
export function lineFor(canary: CanaryClass): string {
  return `marker ${canary.id} ${canary.template.replace("{v}", () => canary.value)}`;
}

export interface RulePattern {
  rule: Rule;
  pattern: ScanPattern;
}

/**
 * Scan pattern of each enabled rule. Mirrors the private `patternOf` in src/core/masker.ts,
 * so spans can be attributed to a rule id. Keep in sync if masker.ts changes.
 */
export function rulePatterns(
  rules: readonly Rule[],
  env: Record<string, string | undefined>,
): RulePattern[] {
  return rules.flatMap((rule): RulePattern[] => {
    if (!rule.enabled) return [];
    switch (rule.type) {
      case "regex":
        return [
          {
            rule,
            pattern: {
              source: rule.pattern,
              flags: rule.flags,
              group: rule.group,
              keywords: rule.keywords,
              entropy: rule.entropy,
              allow: rule.allow,
              validate: rule.validate,
            },
          },
        ];
      case "literal":
        return [{ rule, pattern: literalPattern(rule.values, false) }];
      case "env": {
        const values = envValues(rule, env);
        return values.length > 0
          ? [{ rule, pattern: literalPattern(values, false) }]
          : [];
      }
      case "keyed":
        return [{ rule, pattern: keyedPattern(rule.keys, rule.value) }];
    }
  });
}

/** Rules the extension uses for a configuration level, merged with the defaults. */
export function effectiveRules(level: RawConfig): Rule[] {
  return validateConfig(mergeConfigs([level])).config.rules;
}

export interface AttributedSpan {
  ruleId: string;
  start: number;
  end: number;
}

/** Raw scanner spans, before the masker's token and overlap filters, with rule attribution. */
export async function scanAttributed(
  scanner: Scanner,
  patterns: RulePattern[],
  texts: string[],
): Promise<AttributedSpan[][]> {
  if (patterns.length === 0) return texts.map(() => []);
  const found = await scanner.scan(
    patterns.map((entry) => entry.pattern),
    texts,
  );
  return found.map((spans) =>
    spans.map(([start, end, index]) => ({
      ruleId: patterns[index].rule.id,
      start,
      end,
    })),
  );
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0) throw new Error("empty needle");
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export interface SinkCounts {
  raw: number;
  base64: number;
  /** Null when the percent form equals the raw form, so it is not counted twice. */
  percent: number | null;
}

/**
 * Base64 text of the whole 3-byte groups of a canary, one needle per byte alignment (0, 1, 2).
 * A canary inside a larger base64 text starts at one of the three alignments. The partial first
 * and last groups depend on bytes outside the canary, so they are dropped.
 */
function base64Needles(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  return [0, 1, 2].map((shift) => {
    const encoded = Buffer.concat([
      Buffer.alloc(shift),
      bytes,
      Buffer.alloc(2),
    ]).toString("base64");
    return encoded.slice(
      4 * Math.ceil(shift / 3),
      4 * Math.floor((shift + bytes.length) / 3),
    );
  });
}

/** Literal byte counts of one canary in one sink. Encoded counts stay apart from raw. */
export function countSink(buffer: Buffer, canary: CanaryClass): SinkCounts {
  const percent = encodeURIComponent(canary.value);
  return {
    raw: occurrences(buffer, Buffer.from(canary.value, "utf8")),
    base64: base64Needles(canary.value).reduce(
      (sum, needle) => sum + occurrences(buffer, Buffer.from(needle, "utf8")),
      0,
    ),
    percent:
      percent === canary.value
        ? null
        : occurrences(buffer, Buffer.from(percent, "utf8")),
  };
}

export function countAll(
  buffer: Buffer,
  canaries: CanaryClass[],
): Record<ClassId, SinkCounts> {
  return Object.fromEntries(
    canaries.map((canary) => [canary.id, countSink(buffer, canary)]),
  ) as Record<ClassId, SinkCounts>;
}
