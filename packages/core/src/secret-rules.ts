import { type Allowlist, regexRule, type Rule } from "./config.ts";

/**
 * A token start in raw text, in escaped text (`\n`, `\t`), or in
 * quoted-printable and URL-encoded text (`=3D`, `%3D`).
 */
const START = /(?:(?<![A-Za-z0-9])|(?<=\\[nt]|%3D|=3D))/.source;
/** A quote mark, also as an HTML or decimal entity. */
const QUOTE = /(?:\\?["'`]|&(?:quot|#34|#x22);)/.source;
const SEPARATOR = /\s*(?:=3D|%3D|[:=])\s*/.source;
const QUOTED_VALUE = /((?:[^"'`\\\s]|\\[^\s]){4,200})/.source;
const BARE_VALUE =
  /(?![=!?|*+])([^\s"'`,;:(){}[\]<>\\&.]{4,200})(?=[\s"'`,;)}\]&\\]|$)/.source;
/**
 * Quoted (JSON-escaped too) or unquoted up to a delimiter. Unquoted values
 * exclude `:` and `.` (URN and dotted names) and a leading operator (`==`, `!`).
 */
const VALUE = `(?:${QUOTE}${QUOTED_VALUE}${QUOTE}|${BARE_VALUE})`;
/** The end of an unquoted line value: an optional `,` or `;`, then an optional `# comment`. */
const LINE_END = /[,;]?[ \t]*(?:#[^\n]*)?$/.source;
/** A dotted path of words, or a call, that fills its line: a code reference, not a secret. */
const CODE_REFERENCE =
  /(?:[A-Za-z_$][\w$.]{0,200}\([^)\n]{0,200}\)|[A-Za-z_$]+(?:\??\.[A-Za-z_$]+)+)/
    .source;
/**
 * An unquoted value that runs to the end of its line, so it may hold `.`, `:`,
 * `&`, `(` and `<`. It stops before a `&name=` or `;name=` (a query or
 * connection string part), and it is not a code reference. Needs the `m` flag.
 */
const LINE_VALUE = `(?![=!?|*+])(?![^\\s"'\`]{0,200}[&;][A-Za-z][A-Za-z0-9_]*=)(?!${CODE_REFERENCE}${LINE_END})([^\\s"'\`]{3,199}[^\\s"'\`,;])(?=${LINE_END})`;
/** A keyed value: quoted, the rest of its line, or unquoted up to a delimiter. */
const KEYED_VALUE = `(?:${QUOTE}${QUOTED_VALUE}${QUOTE}|${LINE_VALUE}|${BARE_VALUE})`;
const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.source;
/** Base64 text in lines, such as a PEM or PuTTY key body. */
const BASE64_LINES = /[A-Za-z0-9+/=]{1,4000}(?:\n[A-Za-z0-9+/=]{1,4000}){0,400}/.source;
/** Vendor key bodies with a fixed or bounded shape; each is matched as a whole token. */
const VENDOR_KEYS: [string, string][] = [
  ["mapbox-token", String.raw`sk\.eyJ[A-Za-z0-9_-]{20,200}\.[A-Za-z0-9_-]{20,200}`],
  ["infisical-token", String.raw`st\.${UUID}\.[a-f0-9]{32}\.[a-f0-9]{32}`],
  ["asana-token", String.raw`\d/\d{8,30}(?:/\d{8,30})?:[a-f0-9]{32}`],
  ["fal-key", String.raw`${UUID}:[a-f0-9]{32}`],
  ["e2b-key", String.raw`e2b_[a-f0-9]{40}`],
  ["langsmith-key", String.raw`lsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}`],
  ["mailchimp-key", String.raw`[a-f0-9]{32}-us\d{1,2}`],
  ["mailgun-key", String.raw`[a-f0-9]{32}-[a-f0-9]{8}-[a-f0-9]{8}`],
  ["mailgun-legacy-key", String.raw`key-[a-f0-9]{32}`],
  ["klaviyo-key", String.raw`pk_[a-z0-9]{34}`],
  ["age-secret-key", String.raw`AGE-SECRET-KEY-1[A-Z0-9]{58}`],
  ["axiom-token", String.raw`xa[ap]t-${UUID}`],
  ["twilio-key", String.raw`SK[a-f0-9]{32}`],
  ["tavily-key", String.raw`tvly-(?:dev-)?[A-Za-z0-9]{20,200}`],
  ["neon-key", String.raw`napi_[a-z0-9]{40,100}`],
  ["firecrawl-key", String.raw`fc-[a-f0-9]{32}`],
  ["trigger-key", String.raw`tr_(?:dev|prod|stg|pat)_[A-Za-z0-9]{20,64}`],
  ["shopify-token", String.raw`shpss_[a-f0-9]{32}`],
  ["new-relic-user-key", String.raw`NRAK-[A-Z0-9]{20,40}`],
  ["hubspot-token", String.raw`pat-(?:na|eu|ap)\d-${UUID}`],
  ["linear-oauth-token", String.raw`lin_oauth_[a-f0-9]{64}`],
  ["braintree-token", String.raw`access_token\$(?:production|sandbox)\$[a-z0-9]{16}\$[a-f0-9]{32}`],
];

/** Long key words match with any prefix; short ones need a separator or stand alone. */
const SECRET_KEY =
  /(?:[A-Za-z0-9_-]{0,40}(?:password|passwd|passcode|secret[_-]?key|secret|api[_-]?key|token|auth|credentials?|(?:private|access)[_-]?key(?:[_-]?id)?)|(?:[A-Za-z0-9]{1,40}[_-])?(?:pass|pwd|pw|pat|sig))(?![A-Za-z0-9])/
    .source;

/** Values that name a variable, a placeholder, a type, a code reference or a path. */
const STAND_IN: Allowlist = {
  target: "secret",
  regexes: [
    "^[$<{\\[%@*/~.]",
    "^(?:urn|https?):",
    "^-{3,}",
    "^(?:[xX*#.-]+|0+)$",
    "^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$",
    "[!=]==|!=|\\?\\?|\\|\\|",
    // Letters only, or words joined by `_`: an identifier, a type, an env var name or a dictionary word.
    "^[A-Za-z]+(?:_[A-Za-z]+)*$",
  ],
  stopwords: [
    "changeme",
    "change_me",
    "placeholder",
    "example",
    "dummy",
    "redacted",
    "your_",
    "your-",
    "process.env",
    "os.environ",
    "getenv",
  ],
  all: false,
};

/** Secrets the entropy rules miss, plus the vendor formats gitleaks lacks. Group 1 or `auto` is the value. */
export const SECRET_RULES: Rule[] = [
  ...VENDOR_KEYS.map(([id, body]) =>
    regexRule(id, `${START}(${body})(?![A-Za-z0-9_-])`, { group: 1 }),
  ),
  regexRule(
    "table-cell-secret",
    /\|\s*[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\s*\|\s*([A-Za-z0-9]{16,200})\s*\|/.source,
    { group: 1 },
  ),
  regexRule(
    "keyed-secret",
    `${START}${SECRET_KEY}(?:${QUOTE})?${SEPARATOR}${KEYED_VALUE}`,
    { group: "auto", flags: "im", allow: [STAND_IN] },
  ),
  regexRule(
    "connection-password",
    /[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s:@/[\]]{0,80}:(?!\d{1,5}[/?#])([^\s@]{1,200})@/.source,
    { group: 1 },
  ),
  regexRule(
    "bearer-token",
    /\bBearer\s+([A-Za-z0-9._~+/%-]{16,200}={0,2})/.source,
    { group: 1 },
  ),
  regexRule(
    "authorization-scheme",
    /[Aa]uthorization["']?\s*[:=]\s*["']?(?:Basic|token)\s+([A-Za-z0-9._~+/=-]{8,200})/
      .source,
    { group: 1, flags: "i" },
  ),
  regexRule(
    "authorization-hex",
    /[Aa]uthorization["']?\s*[:=]\s*["']?([a-f0-9]{32,64})(?![A-Za-z0-9])/.source,
    { group: 1 },
  ),
  regexRule(
    "cli-password",
    /\bgh\s+secret\s+set\s+\S{1,80}\s+--body\s+([^\s"'`;|&]{4,200})|\b(?:mysql|mysqldump|mysqladmin|mariadb|psql)\b[^\n]{0,200}?\s-p([^\s"'`;|&]{4,200})|--(?:password|passwd|pass|token|api-key|client-secret|auth-token|access-token)\s+([^\s"'`;|&]{4,200})|\bdocker\s+login\b[^\n]{0,200}?\s-p\s+([^\s"'`;|&]{4,200})|\b(?:curl|wget|http|xh)\b[^\n]{0,200}?\s-u\s*[^\s:"'`]{1,80}:([^\s"'`;|&]{4,200})|\b(?:sshpass|sqlcmd|zip|mongosh|mongo)\b[^\n]{0,200}?\s-[pP]\s+([^\s"'`;|&]{4,200})|\b7z\b[^\n]{0,200}?\s-p([^\s"'`;|&]{4,200})|\b(?:redis-cli|valkey-cli)\b[^\n]{0,200}?\s-a\s+([^\s"'`;|&]{4,200})|\bldapsearch\b[^\n]{0,200}?\s-w\s+([^\s"'`;|&]{4,200})|\bsmbclient\b[^\n]{0,200}?\s-U\s*[^\s:"'`%]{1,80}%([^\s"'`;|&]{4,200})|\bhtpasswd\b[^\n]{0,200}?\s-b\s+[^\s"'`;|&]{1,200}\s+[^\s"'`;|&]{1,80}\s+([^\s"'`;|&]{4,200})|\brabbitmqctl\s+(?:add_user|change_password)\s+\S{1,80}\s+([^\s"'`;|&]{4,200})|\bnet\s+user\s+\S{1,80}\s+([^\s"'`;|&/]{4,200})/
      .source,
    { group: "auto", allow: [STAND_IN] },
  ),
  regexRule(
    "newrelic-license-key",
    `${START}([a-f0-9]{36}NRAL)(?![A-Za-z0-9])`,
    { group: 1 },
  ),
  regexRule(
    "figma-token",
    `${START}(figd_[A-Za-z0-9_-]{40,200})(?![A-Za-z0-9_-])`,
    { group: 1 },
  ),
  regexRule(
    "telegram-bot-token",
    /(?<![0-9])(\d{8,10}:[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/.source,
    { group: 1 },
  ),
  regexRule(
    "session-cookie",
    /\bcookie\b[^\n]{0,400}?\b[A-Za-z0-9_.-]{0,40}(?:session|sess|sid)[A-Za-z0-9_.-]{0,20}=([A-Za-z0-9%._-]{16,200})/
      .source,
    { group: 1, flags: "i" },
  ),
  regexRule(
    "netrc-password",
    /\bmachine\s+\S{1,200}\s+(?:login\s+\S{1,200}\s+)?password\s+([^\s"'`;]{4,200})/
      .source,
    { group: 1 },
  ),
  regexRule(
    "pgpass-password",
    /^[^\s:]{1,200}:\d{1,5}:[^\s:]{1,80}:[^\s:]{1,80}:([^\s:]{4,200})$/.source,
    { group: 1, flags: "m" },
  ),
  regexRule(
    "block-scalar-secret",
    `${START}${SECRET_KEY}:[ \\t]*[|>][-+]?[ \\t]*\\n[ \\t]+(\\S{4,200})(?=\\s|$)`,
    { group: 1, flags: "i", allow: [STAND_IN] },
  ),
  regexRule(
    "terraform-default-secret",
    /variable\s+"[A-Za-z0-9_-]{0,60}(?:password|passwd|secret|token|api_?key)[A-Za-z0-9_-]{0,60}"\s*\{[^}]{0,300}?default\s*=\s*"([^"\n]{4,200})"/
      .source,
    { group: 1, flags: "i", allow: [STAND_IN] },
  ),
  regexRule(
    "sql-user-password",
    /\b(?:IDENTIFIED\s+BY|WITH\s+PASSWORD)\s+'([^'\n]{4,200})'/.source,
    { group: 1, flags: "i", allow: [STAND_IN] },
  ),
  regexRule(
    "name-value-secret",
    `\\bname["']?\\s*[:=]\\s*["']?${SECRET_KEY}["']?(?:\\s*,\\s*|\\s+)["']?value["']?\\s*[:=]\\s*${VALUE}`,
    { group: "auto", flags: "i", allow: [STAND_IN] },
  ),
  regexRule(
    "tf-output-secret",
    `${START}${SECRET_KEY}["']?\\s*:\\s*\\{\\s*["']?value["']?\\s*:\\s*${VALUE}`,
    { group: "auto", flags: "i", allow: [STAND_IN] },
  ),
  regexRule(
    "header-map-secret",
    `${START}${SECRET_KEY}:\\[([A-Za-z0-9]{16,200})\\]`,
    { group: 1, flags: "i" },
  ),
  regexRule(
    "twilio-auth-token",
    /AC[a-f0-9]{32}["']\s*,\s*["']([a-f0-9]{32})/.source,
    { group: 1 },
  ),
  regexRule(
    "tfstate-random-password",
    /random_password[^\n]{0,300}?"result"\s*:\s*"([^"\\\n]{4,200})"/.source,
    { group: 1 },
  ),
  regexRule(
    "netscape-cookie-session",
    /\t(?:TRUE|FALSE)\t[^\t\n]{1,200}\t(?:TRUE|FALSE)\t\d{1,12}\t[A-Za-z0-9_.-]{0,40}(?:session|sess|sid)[A-Za-z0-9_.-]{0,20}\t([A-Za-z0-9%._-]{16,200})/
      .source,
    { group: 1, flags: "i" },
  ),
  regexRule(
    "putty-private-lines",
    `Private-Lines: \\d{1,3}\\n(${BASE64_LINES})`,
    { group: 1 },
  ),
  regexRule(
    "pem-body",
    `-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----\\s*(${BASE64_LINES})`,
    { group: 1 },
  ),
  regexRule(
    "dropbox-token",
    `${START}(sl\\.[A-Za-z0-9_-]{100,200})(?![A-Za-z0-9_-])`,
    { group: 1 },
  ),
];
