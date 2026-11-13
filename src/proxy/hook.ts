import { join } from "node:path";
import {
  CodedError,
  isProtectedPath,
  isRecord,
  protectedPatterns,
  shellReadings,
} from "../core/index.ts";

export interface HookOptions {
  configPath: string;
  home: string;
  /** The adapter's own files, protected like the proxy protects them. */
  protectedPaths: readonly string[];
  /** The tools that the adapter restores, so the configuration validates as it does in the proxy. */
  tools: readonly string[];
  /** The paths, or command words that may be paths, that a call to `tool` opens. */
  targets(tool: string, input: Record<string, unknown>): string[];
}

/** A word list, not a parser: quotes split words, so a quoted path with a blank is not seen whole. The words of the command without its quotes and backslashes count too, so `.e''nv` reads as `.env`. */
export function commandWords(command: string): string[] {
  const words = shellReadings(command).flatMap((reading) =>
    reading.split(/[\s;&|()<>`'"]+/),
  );
  return [...new Set(words)].filter((word) => word !== "");
}

/** The shell reads a word `~/...`, `$HOME/...` or `${HOME}/...` from home. Another user's `~name` stays a relative word. */
function fromHome(target: string, home: string): string {
  const prefix = /^(?:~|\$HOME|\$\{HOME\})\//.exec(target)?.[0];
  return prefix === undefined ? target : join(home, target.slice(prefix.length));
}

/** The PreToolUse hook output that denies the call in `input`, or undefined when it opens no protected path. */
export function hookDenial(
  input: unknown,
  { configPath, home, protectedPaths, tools, targets }: HookOptions,
): string | undefined {
  if (!isRecord(input) || typeof input.cwd !== "string")
    throw new CodedError("HOOK_INPUT");
  const { cwd, tool_name: tool, tool_input: toolInput } = input;
  if (typeof tool !== "string" || !isRecord(toolInput))
    throw new CodedError("HOOK_INPUT");
  const patterns = protectedPatterns([configPath], {
    rules: [],
    protectedPaths,
    tools,
  });
  const path = targets(tool, toolInput).find((target) =>
    isProtectedPath(fromHome(target, home), cwd, patterns),
  );
  if (path === undefined) return undefined;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `lmsk: ${path} is a protected path`,
    },
  });
}
