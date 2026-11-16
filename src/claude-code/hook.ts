import {
  CodedError,
  commandWords,
  deleteVault,
  isRecord,
  machinePaths,
  sessionDir,
} from "../core/index.ts";
import { hookDenial } from "../proxy/index.ts";
import { pathOf, rootsOf, TOOLS } from "./profile.ts";

export interface HookEnv {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The state folder of the proxy service, which the install gives the hook: Claude Code can run with another `XDG_STATE_HOME`. */
  stateDir?: string;
}

/** The output of the Claude Code hook for `input`: the PreToolUse decision, or none at SessionEnd, which deletes the vault of the session. */
export function claudeHook(
  input: unknown,
  { env, home, stateDir }: HookEnv,
): string | undefined {
  const paths = machinePaths(env, home);
  if (isRecord(input) && input.hook_event_name === "SessionEnd") {
    if (typeof input.session_id !== "string")
      throw new CodedError("HOOK_INPUT");
    deleteVault(sessionDir(stateDir ?? paths.stateDir, input.session_id));
    return undefined;
  }
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
    roots: rootsOf,
  });
}
