import { isAbsolute, join } from "node:path";

export interface MachinePaths {
  configPath: string;
  stateDir: string;
  /** The files that an agent tool must not open: lmsk's machine state and configurations, and pi's earlier stores. */
  protectedPaths: string[];
}

/** An XDG base directory: the variable when it is absolute, else the default under home. */
function baseDir(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

export function machinePaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): MachinePaths {
  const configDir = join(
    baseDir(env.XDG_CONFIG_HOME, join(home, ".config")),
    "lmsk",
  );
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
    ],
  };
}
