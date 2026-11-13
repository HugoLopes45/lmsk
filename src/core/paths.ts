import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MachinePaths {
  configPath: string;
  stateDir: string;
  /** The files that an agent tool must not open: lmsk's machine state, configurations and code, pi's earlier stores, and the files that start lmsk for Claude Code. */
  protectedPaths: string[];
  /** The service files that `lmsk install claude` writes. */
  launchdPath: string;
  systemdPath: string;
}

/** The code that the hook and the service run, from `src/core` and from `dist/core`. */
const CODE = fileURLToPath(new URL("../../dist/**", import.meta.url));

/** A base directory: the variable when it is absolute, else the default under home. */
function baseDir(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

export function machinePaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): MachinePaths {
  const configBase = baseDir(env.XDG_CONFIG_HOME, join(home, ".config"));
  const configDir = join(configBase, "lmsk");
  const launchdPath = join(
    home,
    "Library",
    "LaunchAgents",
    "io.github.hugolopes45.lmsk.plist",
  );
  const systemdPath = join(configBase, "systemd", "user", "lmsk.service");
  const stateDir = join(
    baseDir(env.XDG_STATE_HOME, join(home, ".local", "state")),
    "lmsk",
  );
  return {
    configPath: join(configDir, "config.json"),
    stateDir,
    protectedPaths: [
      `${configDir}/**`,
      `${stateDir}/**`,
      // pi's configuration and the stores of earlier pi versions, which hold reals, wherever PI_CODING_AGENT_DIR puts them.
      "**/lmsk-vaults/**",
      "**/lmsk/config.json",
      // The state files, also by a path relative to a folder such as ~/.local/state.
      ...["key", "vault.jsonl", "vault.lock", "serve-token", "upstream"].map(
        (name) => `**/lmsk/${name}`,
      ),
      // A change to these turns off the hook or the proxy of Claude Code.
      "**/.claude/settings*.json",
      join(
        baseDir(env.CLAUDE_CONFIG_DIR, join(home, ".claude")),
        "settings*.json",
      ),
      launchdPath,
      systemdPath,
      CODE,
    ],
    launchdPath,
    systemdPath,
  };
}
