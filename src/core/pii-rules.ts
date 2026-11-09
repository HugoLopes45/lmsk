import { regexRule, type Rule } from "./config.ts";

const CARD =
  "(?:4(?:\\d{12,18}|\\d{3}(?:[ -]\\d{4}){2}(?:[ -]\\d{1,3}|[ -]\\d{4}(?:[ -]\\d{1,3})?))|(?:5[1-5]|2[2-7])(?:\\d{14}|\\d{2}(?:[ -]\\d{4}){3})|3[47](?:\\d{13}|\\d{2}[ -]\\d{6}[ -]\\d{5}|\\d{2}(?:[ -]\\d{4}){2}[ -]\\d{3})|6(?:011|5\\d{2}|4[4-9]\\d)(?:\\d{12,15}|(?:[ -]\\d{4}){3}(?:[ -]\\d{1,3})?))";

/**
 * Personal data. Each number kind has a tight shape, and a checksum where one exists.
 * Names and postal addresses have no rule: they need entity recognition.
 */
export const PII_RULES: Rule[] = [
  // Not a URL's user-info before `@host`: the connection rule masks that password alone.
  regexRule(
    "email",
    "\\b(?<![A-Za-z][A-Za-z0-9+.-]{0,30}:\\/\\/[^\\s:@/[\\]]{0,80}:[^\\s@/?#]{0,200})(?!git@[A-Za-z0-9.-]{1,253}[:/])[A-Za-z0-9._%+-]{1,64}@(?!\\d{1,3}x\\.)(?:[A-Za-z0-9-]{1,63}\\.){1,8}[A-Za-z]{2,63}\\b",
    { strategy: "shape" },
  ),
  // `_` glues a uuid into file names, such as `<date>_<uuid>.jsonl`.
  regexRule(
    "uuid",
    "(?<![0-9a-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z])",
    { flags: "i" },
  ),
  regexRule(
    "phone-fr",
    "(?<![\\w+])(?:\\+33[ .-]?|0)[1-9](?:[ .-]?\\d{2}){4}(?!\\d)",
  ),
  regexRule(
    "phone-us",
    "(?<![\\w+])(?:\\+1[ .-]?)?(?:\\(\\d{3}\\)[ .-]?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}(?!\\d)",
  ),
  regexRule("phone-e164", "(?<![\\w+])\\+[1-9](?:[ .-]?\\d){7,14}(?!\\d)"),
  regexRule(
    "iban",
    "\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\\b",
    { validate: "iban" },
  ),
  regexRule(
    "credit-card",
    `(?:\\b(?:card|card_number|pan)\\s*[:=]\\s*(${CARD}(?:[ -]?\\d{3,4})?)\\b(?:(?![ -]\\d)|(?=[ -]${CARD}\\b))|\\b(${CARD}))\\b`,
    { flags: "i", group: "auto", validate: "luhn" },
  ),
  regexRule(
    "fr-nir",
    "\\b[12] ?\\d{2} ?(?:0[1-9]|1[0-2]) ?(?:\\d{2}|2[AB]) ?\\d{3} ?\\d{3} ?\\d{2}\\b",
    { validate: "fr-nir" },
  ),
  regexRule(
    "us-ssn",
    "\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b",
  ),
  regexRule(
    "ipv4",
    "(?<!\\w|\\.|§ ?|[Ss]ection[ -]|\\/\\/ )\\d{1,3}(?:\\.\\d{1,3}){3}(?![\\w-]|\\.\\d)",
    {
      validate: "public-ipv4",
    },
  ),
  regexRule("ipv6", "(?<![\\w:]|\\.\\d)[0-9A-Fa-f:]{2,39}(?![\\w:]|\\.\\d)", {
    validate: "public-ipv6",
  }),
  regexRule(
    "mac",
    "\\b[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\\1){4}[0-9A-Fa-f]{2}\\b",
  ),
];
