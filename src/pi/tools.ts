import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandWords, fromHome } from "../core/index.ts";
import type { HookApi } from "./host.ts";

const PATH_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
]);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** The rewrites that pi's tools apply before they open a path (`normalizePath` in pi's `dist/utils/paths.js`, not exported). */
function normalizePath(path: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  const bare = spaced.startsWith("@") ? spaced.slice(1) : spaced;
  if (bare === "~") return homedir();
  if (bare.startsWith("~/")) return join(homedir(), bare.slice(2));
  // An invalid URL throws, and pi blocks a tool call whose hook throws.
  return bare.startsWith("file://") ? fileURLToPath(bare) : bare;
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** The path that a core path tool opens, as pi's tool resolves it, or the words of a shell command that may be paths. */
export function targetsOf(
  tool: string,
  input: Record<string, unknown>,
): string[] {
  if (PATH_TOOLS.has(tool))
    return typeof input.path === "string" ? [normalizePath(input.path)] : [];
  return SHELL_TOOLS.has(tool) && typeof input.command === "string"
    ? commandWords(input.command).map((word) => fromHome(word, homedir()))
    : [];
}

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "find", "ls"]);

/** The folder that a core search or list tool reads: its `path`, or the session folder without one. */
export function rootsOf(
  tool: string,
  input: Record<string, unknown>,
): string[] {
  if (!SEARCH_TOOLS.has(tool)) return [];
  return [normalizePath(typeof input.path === "string" ? input.path : ".")];
}

/** The input field that holds a shell command. */
export function commandKeyOf(tool: string): string | undefined {
  return tool === "bash" ? "command" : undefined;
}

/** Pi lists a core builtin as `builtin:<name>`. A same-named extension tool replaces it and fails this check. */
export function isBuiltinTool(pi: HookApi, name: string): boolean {
  const tool = pi.getAllTools().find((candidate) => candidate.name === name);
  return (
    tool?.sourceInfo.source === "builtin" &&
    tool.sourceInfo.path === `builtin:${name}`
  );
}
