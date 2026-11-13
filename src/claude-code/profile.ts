import { allFormats, anthropicStream } from "../formats/index.ts";
import type { ProxyProfile } from "../proxy/index.ts";

/** The input field of each built-in tool that holds the path it opens. */
const PATH_KEYS = new Map([
  ["Read", "file_path"],
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["Grep", "path"],
  ["Glob", "path"],
  ["NotebookEdit", "notebook_path"],
  ["MultiEdit", "file_path"],
]);

export const TOOLS = [...PATH_KEYS.keys(), "Bash"];

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

/** The folder that a search tool reads: its `path`, or the session folder without one. */
export function rootsOf(
  tool: string,
  input: Record<string, unknown>,
): string[] {
  return SEARCH_TOOLS.has(tool) ? [pathOf(tool, input) ?? "."] : [];
}

export function pathOf(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  const key = PATH_KEYS.get(tool);
  const path = key === undefined ? undefined : input[key];
  return typeof path === "string" ? path : undefined;
}

export interface ClaudeProfileOptions {
  /** The directory that relative tool paths resolve against. */
  cwd: string;
  /** Its ANTHROPIC_BASE_URL, if set, is the upstream. */
  env: Readonly<Record<string, string | undefined>>;
  protectedPaths: readonly string[];
}

export function claudeProfile({
  cwd,
  env,
  protectedPaths,
}: ClaudeProfileOptions): ProxyProfile {
  return {
    name: "lmsk",
    tools: TOOLS,
    protectedPaths,
    format: allFormats,
    // A user who already routes Claude Code through a gateway keeps it behind the proxy.
    upstream: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    keptHeaders: ["x-claude-code-session-id"],
    cwd,
    codec: anthropicStream,
    commandKey: (tool) => (tool === "Bash" ? "command" : undefined),
    pathOf,
    rootsOf,
  };
}
