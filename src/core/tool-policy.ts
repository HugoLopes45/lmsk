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

/** A restored value in such a command would leave the machine. A word list, not a sandbox: any shell indirection evades it, such as quotes, backslashes, brace expansion, variables, options between the words or an interpreter. */
export function isNetworkCommand(command: string, config: MaskConfig): boolean {
  return config.networkCommands.some((name) => {
    const words = name
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ +/g, "\\s+");
    // Not `\b`: an item may end in a character that is not a word character.
    return new RegExp(`(?:^|[\\s;&|(/\`])${words}(?!\\w)`).test(command);
  });
}

/** `matchesGlob` has no dot option: `*` and `**` skip a segment that starts with a dot, such as `~/.config`. The same mark in path and pattern keeps their literal dots equal. Lower case on both sides: macOS and Windows disks open `~/.AWS` as `~/.aws`. */
function undotted(path: string): string {
  return path.replaceAll(/(^|[/{,])\./g, "$1\u0001").toLowerCase();
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
