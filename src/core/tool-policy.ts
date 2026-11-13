import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from "node:path";
import type { MaskConfig } from "./config.ts";

/** A shell command as written, and with its quotes, backslashes and the `$` of `$'...'` deleted, once with its line breaks kept and once with its line continuations joined. So `c\url`, `"curl"`, `$'curl'` and `.e''nv` also read as the words the shell runs. The written form stays, for `python -c'code'`. */
export function shellReadings(command: string): string[] {
  const unquote = (text: string) => text.replace(/\$(?=["'])|["'\\]/g, "");
  return [
    command,
    // A backslash before a line break does not join the lines in a comment or a quoted heredoc.
    unquote(command),
    unquote(
      // A backslash escapes the next character, so `\\` before a line break keeps the line break, as in the shell.
      command.replace(/\\[\s\S]/g, (pair) => (pair === "\\\n" ? "" : pair)),
    ),
  ];
}

/** A word list, not a parser: quotes split words, so a quoted path with a blank is not seen whole. The words of the command without its quotes and backslashes count too, so `.e''nv` reads as `.env`. */
export function commandWords(command: string): string[] {
  const words = shellReadings(command).flatMap((reading) =>
    reading.split(/[\s;&|()<>`'"]+/),
  );
  return [...new Set(words)].filter((word) => word !== "");
}

/** The shell reads a word `~`, `$HOME` or `${HOME}`, alone or before `/...`, from home. Another user's `~name` stays a relative word. */
export function fromHome(target: string, home: string): string {
  const prefix = /^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/.exec(target)?.[0];
  return prefix === undefined
    ? target
    : join(home, target.slice(prefix.length));
}

/** A restored value in such a command would leave the machine. A word list, not a sandbox: a shell expansion such as a split variable, an escape code or a glob, code on standard input, combined options such as `-uc`, or a program that is not in the list evades it. The words of an item may have up to 10 other words between them, such as `git -C dir push`. The gap can cross a line break. */
export function isNetworkCommand(command: string, config: MaskConfig): boolean {
  return config.networkCommands.some((name) => {
    const words = name
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      // A bound: an open gap makes each repeated first word scan to the end, so a long command takes quadratic time.
      .replace(/ +/g, "(?:\\s+\\S+){0,10}?\\s+");
    // Not `\b`: an item may end in a character that is not a word character.
    const pattern = new RegExp(`(?:^|[\\s;&|(/\`={,])${words}(?!\\w)`);
    return shellReadings(command).some((reading) => pattern.test(reading));
  });
}

/** `matchesGlob` has no dot option: `*` and `**` skip a segment that starts with a dot, such as `~/.config`. The same mark in path and pattern keeps their literal dots equal. Each code point in upper then lower case on both sides: macOS and Windows disks open `~/.AWS` as `~/.aws`, and the long s `ſ` as `s`. One code point at a time, so that a final `ς` folds like `σ`. A fold to more than one code point, as of `ß` or `İ`, is not used, so that `?` still matches the letter. */
function undotted(path: string): string {
  const marked = path.replaceAll(/(^|[/{,])\./g, "$1\u0001");
  return Array.from(marked, (letter) => {
    const single = (text: string) => Array.from(text).length === 1;
    const folded = letter.toUpperCase().toLowerCase();
    if (single(folded)) return folded;
    const lower = letter.toLowerCase();
    return single(lower) ? lower : letter;
  }).join("");
}

/** macOS disks open a letter and its accent written as two code points as the one-code-point letter. Other disks keep the name as written, so both forms are matched. */
function both(text: string): string[] {
  return [...new Set([text, text.normalize("NFC")])];
}

/** The path that `path` leads to through links, also when it does not exist yet: a write follows a linked folder and a dangling link. */
function linkTarget(path: string, budget: { links: number }): string {
  if (existsSync(path)) return realpathSync(path);
  if (budget.links > 0 && isLink(path)) {
    budget.links -= 1;
    const target = readlinkSync(path);
    const from = isAbsolute(target) ? "/" : linkTarget(dirname(path), budget);
    return walk(from, target, budget);
  }
  const parent = dirname(path);
  return parent === path
    ? path
    : join(linkTarget(parent, budget), basename(path));
}

/** A path under a file or in a folder that cannot be read gives an error, and no tool can open such a path through a link. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolves `target` from the real folder `from` one segment at a time, so `..` after a linked folder leaves the folder that the link leads to, as the system does. */
function walk(from: string, target: string, budget: { links: number }): string {
  return target
    .split("/")
    .reduce(
      (real, segment) =>
        segment === ".."
          ? dirname(real)
          : segment === "" || segment === "."
            ? real
            : linkTarget(join(real, segment), budget),
      from,
    );
}

/** The first of `paths` that a pattern matches. Each path is resolved against `cwd` before it is matched. The path on disk is matched too: tools follow links, also before a `..`. */
export function protectedPath(
  paths: readonly string[],
  cwd: string,
  patterns: readonly string[],
): string | undefined {
  const globs = patterns.flatMap(both).map(undotted);
  return paths.find((path) => {
    // 40 links per path is the Linux limit; past it, the write itself fails with ELOOP. One count for the whole path, as the system keeps, bounds links that lead back to each other.
    const budget = { links: 40 };
    const from = isAbsolute(path) ? "/" : linkTarget(cwd, budget);
    return [resolve(cwd, path), walk(from, path, budget)]
      .flatMap(both)
      .some((candidate) => {
        const folded = undotted(candidate);
        return globs.some((glob) => matchesGlob(folded, glob));
      });
  });
}

/** The folder that an absolute pattern names before its first glob character, the folder of a file pattern without one, or a folder pattern that ends in `/`. */
function fixedFolder(pattern: string): string | undefined {
  if (!isAbsolute(pattern)) return undefined;
  const segments = pattern.split("/");
  const glob = segments.findIndex((segment) => /[*?[{]/.test(segment));
  if (glob !== -1) return segments.slice(0, glob).join("/") || "/";
  if (pattern.endsWith("/")) return pattern.replace(/\/+$/, "") || "/";
  return dirname(pattern);
}

/** The path as written from `cwd` and on disk, in both forms, with the marks of `undotted`. */
function forms(path: string, cwd: string): string[] {
  const budget = { links: 40 };
  const onDisk = walk(
    isAbsolute(path) ? "/" : linkTarget(cwd, budget),
    path,
    budget,
  );
  return [resolve(cwd, path), onDisk].flatMap(both).map(undotted);
}

/** `folder` is `root` or below it, segment by segment: `/state` does not hold `/state-other`. */
function holds(root: string, folder: string): boolean {
  const path = relative(root, folder);
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

/**
 * The first of `roots`, the folders that a search tool reads, that is a protected path or holds
 * the fixed folder of an absolute pattern, such as the machine state folder. A pattern that
 * starts with `**` has no fixed folder, so this check does not refuse a search above such a file.
 */
export function searchedPath(
  roots: readonly string[],
  cwd: string,
  patterns: readonly string[],
): string | undefined {
  const hit = protectedPath(roots, cwd, patterns);
  if (hit !== undefined) return hit;
  const folders = patterns.flatMap((pattern) => {
    const folder = fixedFolder(pattern);
    return folder === undefined ? [] : forms(folder, "/");
  });
  return roots.find((root) =>
    forms(root, cwd).some((path) =>
      folders.some((folder) => holds(path, folder)),
    ),
  );
}
