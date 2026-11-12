import { lstatSync, readFileSync } from "node:fs";
import Type, { type Static, type TProperties, type TSchema } from "typebox";
import Value from "typebox/value";
import { GITLEAKS_RULES } from "./gitleaks-rules.ts";
import { PII_RULES } from "./pii-rules.ts";
import { SECRET_RULES } from "./secret-rules.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const Strings = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

function ruleSchema<T extends string, P extends TProperties>(
  type: T,
  properties: P,
) {
  return Type.Object(
    {
      id: Type.String({ pattern: ID }),
      type: Type.Literal(type),
      enabled: Type.Boolean({ default: true }),
      /** `opaque`: same-length random letters and digits. `shape`: each character keeps its class. */
      strategy: Type.Union(
        [
          Type.Literal("opaque"),
          Type.Literal("shape"),
          Type.Literal("fixed"),
          Type.Literal("mask"),
          Type.Literal("block"),
        ],
        { default: "opaque" },
      ),
      /** `fixed`: the replacement, `{n}` numbers distinct values. `mask`: the irreversible text. */
      replacement: Type.Optional(Type.String({ minLength: 1 })),
      ...properties,
    },
    { additionalProperties: false },
  );
}

/** Checks in src/core/validators.mjs that a matched value must pass. */
const VALIDATOR_NAMES = [
  "fr-nir",
  "iban",
  "luhn",
  "public-ipv4",
  "public-ipv6",
] as const;

const AllowlistSchema = Type.Object(
  {
    target: Type.Union([
      Type.Literal("secret"),
      Type.Literal("match"),
      Type.Literal("line"),
    ]),
    regexes: Type.Array(Type.String()),
    stopwords: Type.Array(Type.String()),
    /** Every non-empty check must pass instead of any one. */
    all: Type.Boolean(),
  },
  { additionalProperties: false },
);

const RULE_SCHEMAS = {
  literal: ruleSchema("literal", { values: Strings }),
  env: ruleSchema("env", {
    vars: Type.Optional(Strings),
    /** Regex that a variable name matches, case-insensitively. Matched values under 8 characters, only digits, and an existing absolute path are skipped. */
    namePattern: Type.Optional(Type.String({ minLength: 1 })),
    /** Regex for the names, case-insensitively, whose lowercase host name or URL without credentials is skipped, such as `AUTH_URL`. */
    locationNamePattern: Type.Optional(Type.String({ minLength: 1 })),
  }),
  regex: ruleSchema("regex", {
    pattern: Type.String({ minLength: 1 }),
    flags: Type.String({ pattern: "^[imsu]*$", default: "" }),
    /** `auto` takes the first non-empty group, else the whole match. */
    group: Type.Union([Type.Integer({ minimum: 0 }), Type.Literal("auto")], {
      default: 0,
    }),
    /** Lowercase words; the rule runs only on text that contains one of them. */
    keywords: Type.Optional(Type.Array(Type.String())),
    /** A value is kept only if its Shannon entropy is above this. */
    entropy: Type.Optional(Type.Number({ minimum: 0 })),
    /** A value is kept only if this check passes. */
    validate: Type.Optional(Type.Enum(VALIDATOR_NAMES)),
    allow: Type.Optional(Type.Array(AllowlistSchema)),
  }),
  keyed: ruleSchema("keyed", {
    /** camelCase key names; `apiKey` also matches `api_key`, `API-KEY` and `X_API_KEY`. */
    keys: Type.Array(Type.String({ pattern: "^[A-Za-z0-9]+$" }), {
      minItems: 1,
    }),
    /** Pattern a value must match completely. */
    value: Type.String({ minLength: 1 }),
  }),
};

const RuleSchema = Type.Union([
  RULE_SCHEMAS.literal,
  RULE_SCHEMAS.env,
  RULE_SCHEMAS.regex,
  RULE_SCHEMAS.keyed,
]);

export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    rules: Type.Optional(Type.Array(RuleSchema)),
    /** Globs that the path argument of the host's file tools may not match. */
    protectedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** Command words, not regexes, such as `git push`. The words of an item can have up to 10 other words between them. A shell command that names one keeps its fakes, so no real value leaves the machine. */
    networkCommands: Type.Optional(
      Type.Array(Type.String({ pattern: "^\\S(?:.*\\S)?$" })),
    ),
    /** Tools whose arguments get real values back. Only the tools that the host restores are allowed, so this setting can only remove tools. */
    restoredTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** Replace a text that holds a secret spaced out, wrapped, reversed or encoded with a notice. Off, the provider gets such a text as it is. */
    withholdHiddenCopies: Type.Optional(Type.Boolean()),
    /** A scan that takes longer blocks its request or withholds its tool result. At most 2147483647, the longest delay of `setTimeout`. */
    scanTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 2147483647 }),
    ),
  },
  { additionalProperties: false },
);

export type Rule = Static<typeof RuleSchema>;
export type RegexRule = Static<(typeof RULE_SCHEMAS)["regex"]>;
export type EnvRule = Static<(typeof RULE_SCHEMAS)["env"]>;
/** A finding is skipped if a regex matches its target or the value contains a stopword. */
export type Allowlist = Static<typeof AllowlistSchema>;
/** A level may omit any setting; the merged configuration has all of them. */
export type MaskConfig = Required<Omit<Static<typeof ConfigSchema>, "$schema">>;
export type ValidatorName = (typeof VALIDATOR_NAMES)[number];

// A shorter ID identifies no one, and its fake would restore every copy of a common character.
const ID_VALUE = "(?=[A-Za-z0-9_.:-]{4})[A-Za-z0-9_.:-]*\\d[A-Za-z0-9_.:-]*";

export function regexRule(
  id: string,
  pattern: string,
  fields: Partial<
    Pick<RegexRule, "strategy" | "group" | "flags" | "allow" | "validate">
  > = {},
): RegexRule {
  return {
    id,
    type: "regex",
    enabled: true,
    strategy: "opaque",
    pattern,
    flags: "",
    group: 0,
    ...fields,
  };
}

function keyed(id: string, keys: string[], value: string): Rule {
  return { id, type: "keyed", enabled: true, strategy: "opaque", keys, value };
}

/**
 * A short secret word as a whole part of a name, so `KEYBOARD` and `MONKEY_PATH` do not match.
 * Long words match anywhere, as in `PGPASSWORD` or `SERVICE_APIKEY`.
 */
const SECRET_NAME_PATTERN =
  "(?<![A-Za-z])(?:TOKEN|SECRET|PASS|PAT|PWD|KEY|CREDENTIAL|AUTH)S?(?![A-Za-z])|PASSWORD|PASSWD|PASSPHRASE|APIKEY";

/** gitleaks rules, secret rules, then personal data and identifiers. */
export const DEFAULT_RULES: readonly Rule[] = [
  ...GITLEAKS_RULES,
  ...SECRET_RULES,
  {
    id: "env-secret-names",
    type: "env",
    enabled: true,
    strategy: "opaque",
    namePattern: SECRET_NAME_PATTERN,
    locationNamePattern: "(?:URL|URI|HOST|DOMAIN|ENDPOINT|ISSUER)S?$",
  },
  keyed(
    "keyed-id",
    [
      "clientId",
      "userId",
      "siteId",
      "customerId",
      "accountId",
      "tenantId",
      "orgId",
      "organizationId",
    ],
    ID_VALUE,
  ),
  ...PII_RULES,
  regexRule("prefixed-id", "\\b[A-Z]{2,10}-(\\d{5,})\\b", { group: 1 }),
  regexRule("account-id", "\\b[A-Z]{1,3}\\d{6,8}(?:_[A-Za-z0-9]+)?\\b"),
];

export const DEFAULT_SETTINGS: Omit<MaskConfig, "rules"> = {
  protectedPaths: [
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/*.jks",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/.ssh/**",
    "**/.aws/**",
    "**/.kube/**",
    "**/.gnupg/**",
    "**/.config/gcloud/**",
    "**/.docker/config.json",
    "**/.npmrc",
    "**/.pypirc",
    "**/.netrc",
    "**/.git-credentials",
    "**/*.tfvars",
    "**/*.tfstate",
    "**/secrets.yaml",
    "**/secrets.yml",
  ],
  networkCommands: [
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "nc",
    "ncat",
    "telnet",
    "ftp",
    "socat",
    "openssl s_client",
    "git push",
    "gh",
    "glab",
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "docker push",
    "docker login",
    "podman push",
    "podman login",
    "aws",
    "gcloud",
    "az",
    "kubectl",
    "helm",
    "xh",
    // An interpreter given code inline can open a connection.
    "python -c",
    "python3 -c",
    "node -e",
    "node --eval",
    "node -p",
    "node --print",
    "deno eval",
    "bun -e",
    "bun --eval",
    "bun -p",
    "bun --print",
    "perl -e",
    "perl -E",
    "ruby -e",
    "php -r",
    "eval",
    // Bash opens a connection when a command writes to or reads from such a path.
    "dev/tcp",
    "dev/udp",
  ],
  restoredTools: [],
  withholdHiddenCopies: true,
  scanTimeoutMs: 5000,
};

/** Settings that merge item by item; `!item` removes an item. */
const LIST_KEYS = [
  "protectedPaths",
  "networkCommands",
  "restoredTools",
] as const;

/** One level of configuration as written in a file. */
export type RawConfig = Record<string, unknown>;

/** A lone value becomes a one-item list, so validation reports it instead of dropping it. */
function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Later levels win. Rules merge field by field on `id`; list settings merge item by item. */
export function mergeConfigs(levels: readonly RawConfig[]): RawConfig {
  const rules = new Map<unknown, unknown>(
    DEFAULT_RULES.map((rule) => [rule.id, rule]),
  );
  const lists = LIST_KEYS.map((key) => new Set<unknown>(DEFAULT_SETTINGS[key]));
  const merged: RawConfig = {};
  for (const { rules: levelRules = [], ...rest } of levels) {
    Object.assign(merged, rest);
    for (const rule of asList(levelRules)) {
      if (isRecord(rule))
        rules.set(rule.id, { ...Object(rules.get(rule.id)), ...rule });
      else rules.set(Symbol(), rule);
    }
    LIST_KEYS.forEach((key, index) => {
      for (const item of asList(rest[key] === undefined ? [] : rest[key]))
        if (typeof item === "string" && item.startsWith("!"))
          lists[index].delete(item.slice(1));
        else lists[index].add(item);
    });
  }
  return {
    ...merged,
    rules: [...rules.values()],
    ...Object.fromEntries(
      LIST_KEYS.map((key, index) => [key, [...lists[index]]]),
    ),
  };
}

function schemaProblems(schema: TSchema, value: unknown, at: string): string[] {
  return Value.Errors(schema, value).flatMap((error) => {
    const path =
      [at, ...error.instancePath.split("/").slice(1)]
        .filter(Boolean)
        .join(".") || "config";
    // additionalProperties:false also reports each extra key as "schema is false" on its own path.
    if (error.keyword === "additionalProperties") return [];
    return [
      error.keyword === "boolean"
        ? `${path} is not a known setting.`
        : `${path} ${error.message}.`,
    ];
  });
}

function compiles(pattern: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function regexProblems(rule: RegexRule, at: string): string[] {
  const compiled = compiles(rule.pattern, rule.flags);
  if (!compiled) return [`${at}.pattern is not a valid regular expression.`];
  const groups =
    (new RegExp(`${compiled.source}|`, compiled.flags).exec("")?.length ?? 1) -
    1;
  const problems =
    typeof rule.group === "number" && rule.group > groups
      ? [`${at}.group must be a capture group of the pattern.`]
      : [];
  const lists = rule.allow ?? [];
  if (
    lists.some((list) => list.regexes.some((source) => !compiles(source, "")))
  )
    problems.push(`${at}.allow has an invalid regular expression.`);
  return problems;
}

function envProblems(rule: EnvRule, at: string): string[] {
  if (rule.vars === undefined && rule.namePattern === undefined)
    return [`${at} needs vars or namePattern.`];
  return (["namePattern", "locationNamePattern"] as const).flatMap((key) => {
    const pattern = rule[key];
    return pattern !== undefined && !compiles(pattern, "i")
      ? [`${at}.${key} is not a valid regular expression.`]
      : [];
  });
}

function semanticProblems(rule: Rule, at: string): string[] {
  const fixed =
    rule.strategy === "fixed" && !rule.replacement
      ? [`${at}.replacement is required for the fixed strategy.`]
      : [];
  if (rule.type === "env") return [...fixed, ...envProblems(rule, at)];
  if (rule.type === "regex") return [...fixed, ...regexProblems(rule, at)];
  if (rule.type === "keyed" && !compiles(rule.value, "u"))
    return [...fixed, `${at}.value is not a valid regular expression.`];
  return fixed;
}

function validateRule(raw: unknown): { rule?: Rule; problems: string[] } {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !new RegExp(ID).test(raw.id)
  )
    return { problems: [`rules: every rule needs an id that matches ${ID}.`] };
  const at = `rules.${raw.id}`;
  const schema = Object.entries(RULE_SCHEMAS).find(
    ([type]) => type === raw.type,
  )?.[1];
  if (!schema)
    return {
      problems: [
        `${at}.type must be one of ${Object.keys(RULE_SCHEMAS).join(", ")}.`,
      ],
    };
  const rule = Value.Default(schema, structuredClone(raw));
  if (!Value.Check(RuleSchema, rule))
    return { problems: schemaProblems(schema, rule, at) };
  const problems = semanticProblems(rule, at);
  return problems.length ? { problems } : { rule, problems };
}

export interface ConfigResult {
  config: MaskConfig;
  /** Any problem must block every request: a partial configuration could leak. */
  problems: string[];
}

/** `tools` are the only tools that `restoredTools` may name. */
export function validateConfig(
  raw: RawConfig,
  tools: readonly string[] = [],
): ConfigResult {
  const rules = (Array.isArray(raw.rules) ? raw.rules : []).map(validateRule);
  const settings: unknown = { ...raw, rules: [] };
  const checked = Value.Check(ConfigSchema, settings) ? settings : undefined;
  const problems = [
    ...schemaProblems(ConfigSchema, settings, ""),
    ...(checked?.restoredTools ?? []).flatMap((name) =>
      tools.includes(name)
        ? []
        : [`restoredTools: ${name} is not a tool that the host restores.`],
    ),
    ...rules.flatMap((result) => result.problems),
  ];
  return {
    config: {
      ...DEFAULT_SETTINGS,
      ...checked,
      rules: rules.flatMap((result) => result.rule ?? []),
    },
    problems,
  };
}

export interface LoadedConfig extends ConfigResult {
  /** Files that exist, in merge order. */
  sources: string[];
  /** Raw text of each source, so the masker can keep them out of the payload. */
  texts: string[];
}

/** Fatal: invalid UTF-8 throws instead of becoming U+FFFD. ignoreBOM keeps a byte order mark, which JSON.parse then rejects. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A dangling symlink has an entry of its own, so it is unreadable rather than absent. */
function isAbsent(path: string, error: unknown): boolean {
  if (!isRecord(error) || error.code !== "ENOENT") return false;
  try {
    lstatSync(path);
    return false;
  } catch (lstatError) {
    return isRecord(lstatError) && lstatError.code === "ENOENT";
  }
}

function readLevel(path: string): {
  text?: string;
  level?: RawConfig;
  problem?: string;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (isAbsent(path, error)) return {};
    return { problem: `${path}: cannot be read.` };
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { problem: `${path}: invalid UTF-8.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, problem: `${path}: invalid JSON.` };
  }
  return isRecord(parsed)
    ? { text, level: parsed }
    : { text, problem: `${path}: must contain a JSON object.` };
}

/** Rule ids that the defaults and the global levels define. A project level may not reuse them. */
function inheritedRuleIds(globals: readonly RawConfig[]): Set<unknown> {
  return new Set(
    asList(mergeConfigs(globals).rules).flatMap((rule) =>
      isRecord(rule) ? [rule.id] : [],
    ),
  );
}

/** A project level may add rules, protected paths and network commands. It may not change an inherited rule, remove an item or change another setting. */
function projectProblems(
  inherited: ReadonlySet<unknown>,
  level: RawConfig,
): string[] {
  const rules = asList(level.rules).flatMap((rule) =>
    isRecord(rule) && inherited.has(rule.id)
      ? [`rules.${rule.id} is inherited: project config cannot change it.`]
      : [],
  );
  const removals = (["protectedPaths", "networkCommands"] as const).flatMap(
    (key) =>
      asList(level[key] ?? []).flatMap((item) =>
        typeof item === "string" && item.startsWith("!")
          ? [`${key}: project config cannot remove ${item.slice(1)}.`]
          : [],
      ),
  );
  const globalOnly = (
    ["restoredTools", "withholdHiddenCopies", "scanTimeoutMs"] as const
  ).flatMap((key) =>
    key in level ? [`${key}: only the global config can change it.`] : [],
  );
  return [...rules, ...removals, ...globalOnly];
}

/** The defaults that the host adds, so the global level can change them like any default. */
export interface HostDefaults {
  /** Rules found at run time. */
  rules: readonly Rule[];
  /** The host's own private files, such as its configuration and vault stores. */
  protectedPaths: readonly string[];
  /** The tools whose input the host can restore: the default and the only allowed values of `restoredTools`. */
  tools: readonly string[];
}

/**
 * Read the global levels in order, then the project level, which the caller passes only when the project is trusted.
 * A missing file is an empty level; unreadable or invalid JSON is a problem.
 */
export function loadConfig(
  paths: readonly string[],
  projectPath: string | undefined,
  host: HostDefaults,
): LoadedConfig {
  const globals = paths.map((path) => ({ path, ...readLevel(path) }));
  const projects =
    projectPath === undefined
      ? []
      : [{ path: projectPath, ...readLevel(projectPath) }];
  const read = [...globals, ...projects];
  const found = read.filter((level) => level.text !== undefined);
  const globalLevels = [
    {
      rules: host.rules,
      protectedPaths: host.protectedPaths,
      restoredTools: host.tools,
    },
    ...globals.flatMap((level) => (level.level ? [level.level] : [])),
  ];
  const projectLevels = projects.flatMap((level) =>
    level.level ? [level.level] : [],
  );
  const result = validateConfig(
    mergeConfigs([...globalLevels, ...projectLevels]),
    host.tools,
  );
  const inherited = inheritedRuleIds(globalLevels);
  return {
    config: result.config,
    problems: [
      ...read.flatMap((level) => level.problem ?? []),
      ...projectLevels.flatMap((level) => projectProblems(inherited, level)),
      ...result.problems,
    ],
    sources: found.map((level) => level.path),
    texts: found.flatMap((level) => level.text ?? []),
  };
}

/** The protected path patterns of the global levels. An invalid level keeps the defaults and the host's own files protected, as a blocked session does. */
export function protectedPatterns(
  paths: readonly string[],
  host: HostDefaults,
): readonly string[] {
  const { config, problems } = loadConfig(paths, undefined, host);
  return problems.length === 0
    ? config.protectedPaths
    : [...DEFAULT_SETTINGS.protectedPaths, ...host.protectedPaths];
}
