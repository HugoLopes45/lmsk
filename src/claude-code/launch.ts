import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, protectedPatterns } from "../core/index.ts";
import {
  type ProxyOptions,
  type ProxyPaths,
  proxyPaths,
  runAgent,
  startProxy,
} from "../proxy/index.ts";
import { claudeProfile, TOOLS } from "./profile.ts";

export interface LaunchOptions {
  cwd: string;
  home: string;
  /** The launcher's environment. Its ANTHROPIC_BASE_URL, if set, is the proxy's upstream. */
  env: Readonly<Record<string, string | undefined>>;
  notify: ProxyOptions["notify"];
}

/** Runs `claude args` behind a proxy that lives as long as it, and returns its exit code. */
export async function launchClaude(
  args: readonly string[],
  { cwd, home, env, notify }: LaunchOptions,
): Promise<number> {
  if (
    args.some((arg) => arg === "--settings" || arg.startsWith("--settings="))
  ) {
    notify(
      "lmsk: --settings would replace the settings that send Claude Code through the proxy. Put your settings in ~/.claude/settings.json.",
      "error",
    );
    return 1;
  }
  const gateway = gatewaySettings(cwd, home, env);
  if (gateway !== undefined) {
    notify(
      `lmsk: ${gateway} sets ANTHROPIC_BASE_URL. Set it in the environment of lmsk instead, so that the proxy forwards to it.`,
      "error",
    );
    return 1;
  }
  const paths = proxyPaths(env, home);
  const proxy = await startProxy(
    claudeProfile({ cwd, env, protectedPaths: paths.protectedPaths }),
    { configPaths: [paths.configPath], stateDir: paths.stateDir, env, notify },
  );
  // A session-only plugin, so that the deny hooks run without an edit to ~/.claude.
  const plugin = fileURLToPath(new URL("../../plugin", import.meta.url));
  try {
    // A file, not argv: the settings hold the launch token, and other local users can read argv.
    const dir = mkdtempSync(join(tmpdir(), "lmsk-"));
    try {
      const settings = join(dir, "settings.json");
      writeFileSync(settings, launchSettings(paths, proxy.url), { mode: 0o600 });
      return await runAgent(
        "claude",
        ["--plugin-dir", plugin, "--settings", settings, ...args],
        { cwd, env: { ...env, ANTHROPIC_BASE_URL: proxy.url }, notify },
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  } finally {
    await proxy.close();
  }
}

/**
 * The settings file that sets ANTHROPIC_BASE_URL, if any. The launch settings replace it with the
 * proxy address, so the proxy would send the gateway's credentials to Anthropic. Managed settings
 * are not read: they outrank the launch settings, so Claude Code would not use the proxy at all.
 */
function gatewaySettings(
  cwd: string,
  home: string,
  env: LaunchOptions["env"],
): string | undefined {
  const userDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(userDir, "settings.json"),
  ].find((file) => {
    const settings = readSettings(file);
    return isRecord(settings?.env) && Boolean(settings.env.ANTHROPIC_BASE_URL);
  });
}

/** Claude Code reports a missing or invalid settings file itself and reads no value from it. */
function readSettings(file: string): Record<string, unknown> | undefined {
  try {
    const settings: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(settings) ? settings : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's own deny rules for the protected paths. Unlike the hook, they also cover the
 * files that `@` mentions and IDE context add to a prompt. `//` starts an absolute pattern.
 * Settings `env` overrides the process environment and the project and user settings, so no
 * settings file sends requests past the proxy. An empty provider switch counts as unset.
 * `disableAllHooks` in a project file would also turn off the plugin's deny hook.
 */
function launchSettings(paths: ProxyPaths, url: string): string {
  const patterns = protectedPatterns([paths.configPath], {
    rules: [],
    protectedPaths: paths.protectedPaths,
    tools: TOOLS,
  });
  const deny = patterns.map(
    (pattern) => `Read(/${pattern.startsWith("/") ? "" : "/"}${pattern})`,
  );
  const env = {
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    CLAUDE_CODE_USE_MANTLE: "",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
  };
  return JSON.stringify({ env, permissions: { deny }, disableAllHooks: false });
}
