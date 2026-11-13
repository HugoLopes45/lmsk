import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
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

/** `matchesGlob` has no dot option: `*` and `**` skip a segment that starts with a dot, such as `~/.config`. The same mark in path and pattern keeps their literal dots equal. Upper then lower case on both sides: macOS and Windows disks open `~/.AWS` as `~/.aws`, and the long s `ſ` as `s`. */
function undotted(path: string): string {
  return path
    .replaceAll(/(^|[/{,])\./g, "$1\u0001")
    .toUpperCase()
    .toLowerCase();
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

/** `path` is resolved against `cwd` before it is matched. The path on disk is matched too: tools follow links, also before a `..`. */
export function isProtectedPath(
  path: string,
  cwd: string,
  patterns: readonly string[],
): boolean {
  // 40 links per path is the Linux limit; past it, the write itself fails with ELOOP. One count for the whole path, as the system keeps, bounds links that lead back to each other.
  const budget = { links: 40 };
  const from = isAbsolute(path) ? "/" : linkTarget(cwd, budget);
  const paths = [resolve(cwd, path), walk(from, path, budget)];
  return paths.some((candidate) =>
    patterns.some((pattern) =>
      matchesGlob(undotted(candidate), undotted(pattern)),
    ),
  );
}
