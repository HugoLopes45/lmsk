import { commandWords, hookDenial, proxyPaths } from "@lmsk/proxy";
import { pathOf, TOOLS } from "./profile.ts";

export interface HookEnv {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

/** The output of the PreToolUse hook for the Claude Code hook input `input`. */
export function claudeHook(
  input: unknown,
  { env, home }: HookEnv,
): string | undefined {
  const paths = proxyPaths(env, home);
  return hookDenial(input, {
    configPath: paths.configPath,
    home,
    protectedPaths: paths.protectedPaths,
    tools: TOOLS,
    targets(tool, toolInput) {
      const path = pathOf(tool, toolInput);
      if (path !== undefined) return [path];
      return tool === "Bash" && typeof toolInput.command === "string"
        ? commandWords(toolInput.command)
        : [];
    },
  });
}
