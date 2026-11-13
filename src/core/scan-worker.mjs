// Runs user and default patterns off the main thread, so the parent can stop a
// catastrophic regex with Worker.terminate(). Keyword, entropy and allowlist semantics follow gitleaks
// detect/detect.go (MIT, Copyright (c) 2019 Zachary Rice).
import { parentPort } from "node:worker_threads";
import { CARD_CONTEXT, VALIDATORS, validPan } from "./validators.mjs";

class PatternError extends Error {
  constructor(index) {
    super(`pattern ${index}`);
    this.index = index;
  }
}

// Allowlists and keywords come from the configuration, so a few entries serve every message.
const allowRegexes = new Map();
const keywordFinders = new Map();

function allowRegex(source) {
  let regex = allowRegexes.get(source);
  if (!regex) allowRegexes.set(source, (regex = new RegExp(source)));
  return regex;
}

function compile(pattern, index) {
  try {
    return {
      regex: new RegExp(pattern.source, `${pattern.flags}dg`),
      group: pattern.group,
      keywords: pattern.keywords ?? [],
      entropy: pattern.entropy ?? 0,
      validate: pattern.validate,
      allow: (pattern.allow ?? []).map((list) => ({
        ...list,
        regexes: list.regexes.map(allowRegex),
      })),
    };
  } catch {
    throw new PatternError(index);
  }
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...value].length;
  let bits = 0;
  for (const count of counts.values())
    bits -= (count / length) * Math.log2(count / length);
  return bits;
}

function lineAt(text, start, end) {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const to = text.indexOf("\n", end);
  return text.slice(from, to === -1 ? text.length : to);
}

function allowed(list, secret, match, line) {
  const target =
    list.target === "match" ? match : list.target === "line" ? line() : secret;
  const checks = [];
  if (list.regexes.length)
    checks.push(list.regexes.some((regex) => regex.test(target)));
  if (list.stopwords.length) {
    const lower = secret.toLowerCase();
    checks.push(list.stopwords.some((word) => lower.includes(word)));
  }
  return list.all
    ? checks.length > 0 && checks.every(Boolean)
    : checks.some(Boolean);
}

/** Value range of a match: the chosen group, the first non-empty group for `auto`, else the match without edge newlines. */
function range(match, group) {
  if (group === "auto") {
    const found = match.indices
      .slice(1)
      .find((part, index) => part && match[index + 1]);
    if (found) return found;
  } else if (group > 0) return match.indices[group];
  let [start, end] = match.indices[0];
  while (start < end && match.input[start] === "\n") start++;
  while (end > start && match.input[end - 1] === "\n") end--;
  return [start, end];
}

function accepted(rule, text, match, value) {
  const secret = text.slice(value[0], value[1]);
  if (rule.entropy && entropy(secret) <= rule.entropy) return false;
  const [matchStart, matchEnd] = match.indices[0];
  // Lazy: slicing the line of every match is quadratic on long single-line texts.
  const line = () => lineAt(text, matchStart, matchEnd);
  return !rule.allow.some((list) => allowed(list, secret, match[0], line));
}

/** Index after an empty match: one code point under u or v, so the next match never starts inside a surrogate pair. */
function nextIndex(regex, text) {
  const wide =
    (regex.unicode || regex.unicodeSets) &&
    text.codePointAt(regex.lastIndex) > 0xffff;
  return regex.lastIndex + (wide ? 2 : 1);
}

function addValidatedSpan(state, found, index, text) {
  const previous = state.spans.at(-1);
  if (previous && previous[1] > found[0] && previous[1] === state.contextEnd) {
    // A validated next PAN takes precedence over treating its first group as a code.
    const prefix = text.slice(previous[0], found[0]).replace(/[ -]+$/, "");
    if (validPan(prefix)) previous[1] = previous[0] + prefix.length;
    else {
      previous[1] = found[1];
      state.contextEnd = found[1];
      return;
    }
  }
  state.spans.push([found[0], found[1], index]);
}

function scanCandidate(state, rule, text, match, found, index) {
  const valid =
    !rule.validate ||
    VALIDATORS[rule.validate](text.slice(found[0], found[1]), match[0]);
  if (valid) addValidatedSpan(state, found, index, text);
  const context =
    rule.validate === "luhn" &&
    (CARD_CONTEXT.test(match[0]) || state.contextEnd === found[1]);
  if (valid && context) state.contextEnd = found[1];
  if (valid && !context) return;
  // A rejected whole card must not yield an inner suffix; an accepted contextual card must not hide the next PAN's start.
  if (rule.validate === "luhn") state.cardEnd = found[1];
  rule.regex.lastIndex = match.index;
  rule.regex.lastIndex = nextIndex(rule.regex, text);
}

function scanPattern(text, rule, index) {
  const state = { spans: [], cardEnd: 0, contextEnd: 0 };
  rule.regex.lastIndex = 0;
  for (
    let match = rule.regex.exec(text);
    match;
    match = rule.regex.exec(text)
  ) {
    if (match[0] === "") rule.regex.lastIndex = nextIndex(rule.regex, text);
    const found = range(match, rule.group);
    if (
      !found ||
      found[1] <= Math.max(found[0], state.cardEnd) ||
      !accepted(rule, text, match, found)
    )
      continue;
    scanCandidate(state, rule, text, match, found, index);
  }
  return state.spans;
}

/** One alternation for all keywords: a pass per keyword costs 6x more on large texts. */
function keywordFinder(compiled) {
  const words = [...new Set(compiled.flatMap((rule) => rule.keywords))];
  if (words.length === 0) return () => new Set();
  const source = words
    .toSorted((a, b) => b.length - a.length)
    .map((word) => word.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"))
    .join("|");
  const known = keywordFinders.get(source);
  if (known) return known;
  // The alternation reports only the longest keyword at each start; the shorter ones inside it occur too.
  const inside = new Map(
    words.map((word) => [word, words.filter((other) => word.includes(other))]),
  );
  const find = (lower) => {
    const found = new Set();
    const regex = new RegExp(`(?=(${source}))`, "g");
    for (let match = regex.exec(lower); match; match = regex.exec(lower)) {
      for (const word of inside.get(match[1])) found.add(word);
      regex.lastIndex++;
    }
    return found;
  };
  keywordFinders.set(source, find);
  return find;
}

function scanText(text, compiled, findKeywords) {
  const present = findKeywords(text.toLowerCase());
  const spans = compiled.flatMap((rule, index) => {
    if (
      rule.keywords.length &&
      !rule.keywords.some((word) => present.has(word))
    )
      return [];
    return scanPattern(text, rule, index);
  });
  return spans.sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2]);
}

parentPort?.on("message", ({ id, patterns, texts }) => {
  let compiled;
  try {
    compiled = patterns.map(compile);
  } catch (error) {
    if (!(error instanceof PatternError)) throw error;
    parentPort?.postMessage({
      id,
      ok: false,
      code: "SCAN_PATTERN",
      index: error.index,
    });
    return;
  }
  const findKeywords = keywordFinder(compiled);
  parentPort?.postMessage({
    id,
    ok: true,
    result: texts.map((text) => scanText(text, compiled, findKeywords)),
  });
});
