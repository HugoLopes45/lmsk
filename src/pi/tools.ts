import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookApi } from "./host.ts";

const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

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

/** The path that a core path tool opens, as pi's tool resolves it. */
export function pathOf(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!PATH_TOOLS.has(tool)) return undefined;
  return typeof input.path === "string" ? normalizePath(input.path) : undefined;
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
