import {
  CodedError,
  fromHome,
  isRecord,
  protectedPath,
  protectedPatterns,
  searchedPath,
} from "../core/index.ts";

export interface HookOptions {
  configPath: string;
  home: string;
  /** The adapter's own files, protected like the proxy protects them. */
  protectedPaths: readonly string[];
  /** The tools that the adapter restores, so the configuration validates as it does in the proxy. */
  tools: readonly string[];
  /** The paths, or command words that may be paths, that a call to `tool` opens. */
  targets: (tool: string, input: Record<string, unknown>) => string[];
  /** The folders that a call to `tool` searches. */
  roots: (tool: string, input: Record<string, unknown>) => string[];
}

/** The PreToolUse hook output that denies the call in `input`, or undefined when it opens no protected path. */
export function hookDenial(
  input: unknown,
  { configPath, home, protectedPaths, tools, targets, roots }: HookOptions,
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
  const opened = targets(tool, toolInput);
  const written = [...opened, ...roots(tool, toolInput)];
  const mapped = written.map((target) => fromHome(target, home));
  const target = protectedPath(mapped.slice(0, opened.length), cwd, patterns);
  const hit =
    target ?? searchedPath(mapped.slice(opened.length), cwd, patterns);
  if (hit === undefined) return undefined;
  const path = written[mapped.indexOf(hit)];
  const reason = target === undefined ? "searches" : "is";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `lmsk: ${path} ${reason} a protected path`,
    },
  });
}
