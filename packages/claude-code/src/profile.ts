import { allFormats, anthropicStream, anthropicTurns } from "@lmsk/formats";
import type { ProxyProfile } from "@lmsk/proxy";

/** The input field of each built-in tool that holds the path it opens. */
const PATH_KEYS = new Map([
  ["Read", "file_path"],
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["Grep", "path"],
  ["Glob", "path"],
]);

export const TOOLS = [...PATH_KEYS.keys(), "Bash"];

export function pathOf(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  const key = PATH_KEYS.get(tool);
  const path = key === undefined ? undefined : input[key];
  return typeof path === "string" ? path : undefined;
}

export interface ClaudeProfileOptions {
  /** The directory that Claude Code runs in. */
  cwd: string;
  /** The environment that Claude Code gets. */
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
    upstream: () => env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    keptHeaders: ["x-claude-code-session-id"],
    sessionId: (headers) => {
      const id = headers["x-claude-code-session-id"];
      return typeof id === "string" ? id : undefined;
    },
    cwd,
    codec: anthropicStream,
    turns: anthropicTurns,
    commandKey: (tool) => (tool === "Bash" ? "command" : undefined),
    pathOf,
  };
}
