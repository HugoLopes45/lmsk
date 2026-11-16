import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CodedError, isRecord, machinePaths } from "../core/index.ts";
import {
  type ProxyOptions,
  type RunningProxy,
  startProxy,
} from "../proxy/index.ts";
import { claudeProfile } from "./profile.ts";

/** The port of the proxy that the user settings point Claude Code at. */
export const SERVE_PORT = 25675;

export interface ServeOptions {
  cwd: string;
  home: string;
  /** Its ANTHROPIC_BASE_URL, if set, is the proxy's upstream, else the gateway that the install kept. */
  env: Readonly<Record<string, string | undefined>>;
  notify: ProxyOptions["notify"];
  port: number;
}

/**
 * The first path segment of the proxy URL, created once per machine, so the URL in the user
 * settings stays valid. It keeps other local users from restoring fakes through the proxy.
 */
export function serveToken(stateDir: string): string {
  const path = join(stateDir, "serve-token");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const candidate = join(
    stateDir,
    `serve-token.${randomBytes(16).toString("hex")}.tmp`,
  );
  const fd = openSync(candidate, "wx", 0o600);
  try {
    writeFileSync(fd, randomBytes(32).toString("base64url"));
    try {
      linkSync(candidate, path);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
  } finally {
    closeSync(fd);
    unlinkSync(candidate);
  }
  const token = readFileSync(path, "utf8");
  if (!/^[\w-]{43}$/.test(token)) throw new CodedError("TOKEN_CORRUPT");
  return token;
}

/** Claude Code can rewrite its settings, which hold the proxy token, with a mode that lets other users read or change it. */
function keepSettingsPrivate(file: string, notify: ProxyOptions["notify"]) {
  let mode: number;
  try {
    mode = statSync(file).mode & 0o777;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if ((mode & 0o077) === 0) return;
  chmodSync(file, mode & 0o700);
  notify(
    `lmsk: other users could read or change ${file}, which holds the proxy token. Now only you can. If another user can log in to this computer, delete serve-token in the state folder, then run lmsk install claude.`,
    "warning",
  );
}

const upstreamFile = (stateDir: string) => join(stateDir, "upstream");

/** Keeps the gateway that Claude Code used before the install, from its user settings or the shell. */
export function saveUpstream(stateDir: string, url: string): void {
  writeFileSync(upstreamFile(stateDir), url, { mode: 0o600 });
}

export function savedUpstream(stateDir: string): string | undefined {
  try {
    return readFileSync(upstreamFile(stateDir), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Starts the proxy that serves every Claude Code session of the user. */
export async function serveClaude({
  cwd,
  home,
  env,
  notify,
  port,
}: ServeOptions): Promise<RunningProxy> {
  const paths = machinePaths(env, home);
  const upstream = env.ANTHROPIC_BASE_URL || savedUpstream(paths.stateDir);
  if (upstream === "")
    throw new CodedError("UPSTREAM_INVALID", "the saved upstream is empty");
  keepSettingsPrivate(
    join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"),
    notify,
  );
  return startProxy(
    claudeProfile({
      cwd,
      env: { ...env, ANTHROPIC_BASE_URL: upstream },
      protectedPaths: paths.protectedPaths,
    }),
    {
      configPaths: [paths.configPath],
      stateDir: paths.stateDir,
      env,
      notify,
      port,
      token: serveToken(paths.stateDir),
    },
  );
}
