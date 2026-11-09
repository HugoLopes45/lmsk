// Converts the gitleaks default rules into src/core/gitleaks-rules.ts.
// The rules are data from gitleaks (MIT, Copyright (c) 2019 Zachary Rice).
//
// Usage:
//   curl -fsSLO https://raw.githubusercontent.com/gitleaks/gitleaks/v<version>/config/gitleaks.toml
//   python3 -c 'import json,sys,tomllib; json.dump(tomllib.load(open(sys.argv[1],"rb")), sys.stdout)' gitleaks.toml > gitleaks.json
//   node scripts/import-gitleaks.ts gitleaks.json <version>
import { readFileSync, writeFileSync } from "node:fs";
import { type Allowlist, isRecord, type RegexRule } from "../src/core/config.ts";

interface Flags {
  caseless: boolean;
  dotAll: boolean;
}

interface State {
  flags: Flags;
  stack: Flags[];
}

type Token = [RegExp, (match: RegExpExecArray, state: State) => string];

function parseFlags(text: string, flags: Flags): Flags {
  const next = { ...flags };
  const on = !text.startsWith("-");
  for (const char of on ? text : text.slice(1)) {
    if (char === "i") next.caseless = on;
    else if (char === "s") next.dotAll = on;
    else throw new Error(`unsupported flag group (?${text})`);
  }
  return next;
}

function bothCases(char: string, caseless: boolean): string {
  const lower = char.toLowerCase();
  const upper = char.toUpperCase();
  return caseless && lower !== upper ? `${lower}${upper}` : char;
}

const POSIX: Record<string, string> = { alnum: "A-Za-z0-9" };

// A `\x` escape is read whole so its hex digits are never case-expanded.
const ESCAPE: Token = [/^\\(?:x[0-9A-Fa-f]{2}|[^xpPQEC])/, (match) => match[0]];
const BAD_ESCAPE: Token = [
  /^\\[\s\S]?/,
  (match) => {
    throw new Error(`unsupported escape ${match[0]}`);
  },
];

const CLASS_TOKENS: Token[] = [
  [
    /^\[:(\^?\w+):\]/,
    (match) => {
      const set = POSIX[match[1] ?? ""];
      if (set === undefined) throw new Error(`unsupported class ${match[0]}`);
      return set;
    },
  ],
  ESCAPE,
  BAD_ESCAPE,
  [
    /^([A-Za-z])-([A-Za-z])/,
    ([whole, from = "", to = ""], { flags }) =>
      flags.caseless
        ? `${from.toLowerCase()}-${to.toLowerCase()}${from.toUpperCase()}-${to.toUpperCase()}`
        : whole,
  ],
  [/^\[/, () => "\\["],
  [/^[\s\S]/, ([char = ""], { flags }) => bothCases(char, flags.caseless)],
];

function translate(
  go: string,
  tokens: Token[],
  state: State,
  end?: RegExp,
): { text: string; rest: string } {
  let text = "";
  let rest = go;
  while (rest && !end?.test(rest)) {
    const token = tokens.find(([regex]) => regex.test(rest));
    const match = token?.[0].exec(rest);
    if (!token || !match) throw new Error(`cannot read ${rest.slice(0, 8)}`);
    text += token[1](match, state);
    rest = rest.slice(match[0].length);
  }
  return { text, rest };
}

function pushFlags(state: State, flags: Flags): void {
  state.stack.push(state.flags);
  state.flags = flags;
}

const TOKENS: Token[] = [
  [/^\\z/, () => "$"],
  ESCAPE,
  BAD_ESCAPE,
  [
    /^\(\?([a-zA-Z-]+)\)/,
    ([, flags = ""], state) => (
      (state.flags = parseFlags(flags, state.flags)),
      ""
    ),
  ],
  [
    /^\(\?([a-zA-Z-]+):/,
    ([, flags = ""], state) => (
      pushFlags(state, parseFlags(flags, state.flags)),
      "(?:"
    ),
  ],
  [
    /^\(\?P?<(\w+)>/,
    ([, name], state) => (pushFlags(state, state.flags), `(?<${name}>`),
  ],
  [
    /^\((?:\?[:=!])?/,
    ([opener = ""], state) => (pushFlags(state, state.flags), opener),
  ],
  [
    /^\)/,
    (_, state) => {
      const parent = state.stack.pop();
      if (!parent) throw new Error("unbalanced parenthesis");
      state.flags = parent;
      return ")";
    },
  ],
  [/^\{\d+(?:,\d*)?\}/, ([quantifier = ""]) => quantifier],
  [/^\{/, () => "\\{"],
  [/^\./, (_, { flags }) => (flags.dotAll ? "[\\s\\S]" : ".")],
  [
    /^[\s\S]/,
    ([char = ""], { flags }) => {
      const both = bothCases(char, flags.caseless);
      return both === char ? char : `[${both}]`;
    },
  ],
];

/**
 * Translates a Go RE2 pattern into a JS pattern that needs no flags and runs
 * on Node 22, which lacks RegExp modifiers: case-insensitive scopes become
 * explicit letter classes and dot-all scopes become `[\s\S]`.
 */
export function convertGoRegex(go: string): string {
  const state: State = { flags: { caseless: false, dotAll: false }, stack: [] };
  // Character classes need their own tokens, so the main loop stops at each `[`.
  let out = "";
  let rest = go;
  while (rest) {
    const plain = translate(rest, TOKENS, state, /^\[/);
    // In Go a `]` right after `[` or `[^` is a literal, in JS it ends the class.
    const open = /^\[(\^?)(\]?)/.exec(plain.rest);
    out += plain.text;
    if (!open) break;
    const body = translate(
      plain.rest.slice(open[0].length),
      CLASS_TOKENS,
      state,
      /^\]/,
    );
    if (!body.rest) throw new Error("unterminated character class");
    out += `[${open[1]}${open[2] ? "\\]" : ""}${body.text}]`;
    rest = body.rest.slice(1);
  }
  if (state.stack.length) throw new Error("unbalanced parenthesis");
  return out;
}

export interface Skipped {
  id: string;
  reason: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function allowlist(raw: Record<string, unknown>): Allowlist | undefined {
  const all = raw.condition === "AND";
  // Paths and commits cannot be evaluated on a payload: an AND list that needs them never passes.
  if (all && (strings(raw.paths).length || strings(raw.commits).length))
    return undefined;
  const regexes = strings(raw.regexes).map(convertGoRegex);
  const stopwords = strings(raw.stopwords).map((word) => word.toLowerCase());
  if (!regexes.length && !stopwords.length) return undefined;
  const target =
    raw.regexTarget === "match" || raw.regexTarget === "line"
      ? raw.regexTarget
      : "secret";
  return { target, regexes, stopwords, all };
}

function convertRule(raw: Record<string, unknown>, id: string): RegexRule {
  // A payload has no file path, so a rule limited to some paths cannot keep its meaning.
  if (typeof raw.regex !== "string" || raw.path !== undefined)
    throw new Error("path-scoped rule");
  const pattern = convertGoRegex(raw.regex);
  new RegExp(pattern, "dg");
  const lists = Array.isArray(raw.allowlists)
    ? raw.allowlists.flatMap((item) =>
        isRecord(item) ? (allowlist(item) ?? []) : [],
      )
    : [];
  return {
    id: `gitleaks.${id}`,
    type: "regex",
    enabled: true,
    strategy: "opaque",
    pattern,
    flags: "",
    group:
      typeof raw.secretGroup === "number" && raw.secretGroup > 0
        ? raw.secretGroup
        : "auto",
    keywords: strings(raw.keywords).map((word) => word.toLowerCase()),
    ...(typeof raw.entropy === "number" && raw.entropy > 0
      ? { entropy: raw.entropy }
      : {}),
    ...(lists.length ? { allow: lists } : {}),
  };
}

/** `global` applies to every rule; `rules` carry only their own allowlists. */
export function importGitleaks(config: unknown): {
  rules: RegexRule[];
  global: Allowlist | undefined;
  skipped: Skipped[];
} {
  if (!isRecord(config) || !Array.isArray(config.rules))
    throw new Error("not a gitleaks config");
  const rules: RegexRule[] = [];
  const skipped: Skipped[] = [];
  for (const raw of config.rules) {
    if (!isRecord(raw) || typeof raw.id !== "string")
      throw new Error("rule without id");
    try {
      rules.push(convertRule(raw, raw.id));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      skipped.push({ id: raw.id, reason: error.message });
    }
  }
  return {
    rules,
    global: isRecord(config.allowlist)
      ? allowlist(config.allowlist)
      : undefined,
    skipped,
  };
}

function main(args: string[]): void {
  const [input, version] = args;
  if (!input || !version)
    throw new Error(
      "usage: node scripts/import-gitleaks.ts <gitleaks.json> <version>",
    );
  const {
    rules,
    global: shared,
    skipped,
  } = importGitleaks(JSON.parse(readFileSync(input, "utf8")));
  const text = [
    `// Generated by scripts/import-gitleaks.ts from gitleaks v${version} config/gitleaks.toml.`,
    "// Rule data: gitleaks, MIT License, Copyright (c) 2019 Zachary Rice.",
    `// Skipped: ${skipped.map((rule) => `${rule.id} (${rule.reason})`).join(", ") || "none"}.`,
    'import type { Allowlist, RegexRule } from "./config.ts";',
    "",
    `const GLOBAL: Allowlist[] = ${JSON.stringify(shared ? [shared] : [])};`,
    `const RULES: RegexRule[] = ${JSON.stringify(rules)};`,
    "export const GITLEAKS_RULES: readonly RegexRule[] = RULES.map((rule) => ({",
    "  ...rule,",
    "  allow: [...GLOBAL, ...(rule.allow ?? [])],",
    "}));",
    "",
  ].join("\n");
  writeFileSync(new URL("../src/core/gitleaks-rules.ts", import.meta.url), text);
  process.stdout.write(
    `${rules.length} rules written, ${skipped.length} skipped\n`,
  );
}

if (import.meta.main) main(process.argv.slice(2));
