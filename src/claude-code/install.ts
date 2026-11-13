import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CodedError,
  isRecord,
  machinePaths,
  protectedPatterns,
  SERVICE_LABEL,
} from "../core/index.ts";
import type { ProxyOptions } from "../proxy/index.ts";
import { TOOLS } from "./profile.ts";
import { SERVE_PORT, saveUpstream, serveToken } from "./serve.ts";

export interface InstallOptions {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** The node executable and the lmsk script that the hook and the proxy service run. */
  node: string;
  bin: string;
  /** Runs a service manager command and returns its exit status. */
  run(command: string, args: readonly string[]): number;
  notify: ProxyOptions["notify"];
}

/** Claude Code retries 10 times by default, so it waits about 3 minutes for a proxy that is down. */
const MAX_RETRIES = "3";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new CodedError("SETTINGS_INVALID", `${name} is not an object`);
  return value;
}

function list(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new CodedError("SETTINGS_INVALID", `${name} is not a list`);
  return value;
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CodedError("SETTINGS_INVALID", `${file} is not JSON`);
  }
  return record(settings, file);
}

/** Claude Code sends even a 127.0.0.1 base URL through `HTTP_PROXY`, so that proxy would see the unmasked request. */
function loopbackExempt(value: unknown): string {
  if (typeof value !== "string" || value === "") return "127.0.0.1";
  return value.split(",").includes("127.0.0.1") ? value : `${value},127.0.0.1`;
}

function isLmskHook(hook: unknown): boolean {
  return (
    isRecord(hook) &&
    Array.isArray(hook.args) &&
    hook.args.length === 3 &&
    hook.args[1] === "hook" &&
    hook.args[2] === "claude"
  );
}

/** The group without the lmsk hook, which the install adds again; a group left empty is dropped. */
function withoutLmskHook(group: unknown): unknown[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
  const hooks = group.hooks.filter((hook) => !isLmskHook(hook));
  return hooks.length === 0 ? [] : [{ ...group, hooks }];
}

/**
 * Settings `env` overrides the process environment; an empty provider switch counts as unset,
 * so Claude Code uses the Anthropic API that the proxy serves. Unlike the hook, the deny rules
 * also cover the files that `@` mentions and IDE context add to a prompt.
 */
function installedSettings(
  settings: Record<string, unknown>,
  url: string,
  deny: readonly string[],
  { node, bin, env }: InstallOptions,
): Record<string, unknown> {
  const own = record(settings.env, "env");
  const permissions = record(settings.permissions, "permissions");
  const hooks = record(settings.hooks, "hooks");
  const effective = { ...env, ...own };
  const hook = {
    matcher: TOOLS.join("|"),
    hooks: [
      {
        type: "command",
        command: node,
        args: [bin, "hook", "claude"],
        onFailure: "block",
      },
    ],
  };
  return {
    ...settings,
    env: {
      ...own,
      ANTHROPIC_BASE_URL: url,
      CLAUDE_CODE_MAX_RETRIES: own.CLAUDE_CODE_MAX_RETRIES ?? MAX_RETRIES,
      NO_PROXY: loopbackExempt(effective.NO_PROXY || effective.no_proxy),
      no_proxy: loopbackExempt(effective.no_proxy || effective.NO_PROXY),
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
      CLAUDE_CODE_USE_MANTLE: "",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
    },
    permissions: {
      ...permissions,
      deny: [
        ...new Set([...list(permissions.deny, "permissions.deny"), ...deny]),
      ],
    },
    hooks: {
      ...hooks,
      PreToolUse: [
        ...list(hooks.PreToolUse, "hooks.PreToolUse").flatMap(withoutLmskHook),
        hook,
      ],
    },
  };
}

/** Replaces the file that a symlink points at, in one step. The file holds the URL token. */
function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const target = existsSync(file) ? realpathSync(file) : file;
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, target);
}

function check(status: number, command: string): void {
  if (status !== 0)
    throw new CodedError("SERVICE_FAILED", `${command} exited ${status}`);
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function launchdService(
  { run }: InstallOptions,
  plist: string,
  argv: readonly string[],
  vars: [string, string][],
  log: string,
): void {
  const strings = argv.map((arg) => `<string>${xml(arg)}</string>`).join("");
  const env = vars
    .map(([name, value]) => `<key>${name}</key><string>${xml(value)}</string>`)
    .join("");
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${strings}</array>
<key>EnvironmentVariables</key><dict>${env}</dict>
<key>StandardErrorPath</key><string>${xml(log)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
`,
  );
  const domain = `gui/${process.getuid?.()}`;
  // Fails when no earlier install runs; bootstrap then fails if one still does.
  run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
  check(run("launchctl", ["bootstrap", domain, plist]), "launchctl bootstrap");
}

/** A systemd unit word: quoted, with its specifier signs doubled. */
function unitWord(text: string): string {
  return `"${text.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
}

function systemdService(
  { run }: InstallOptions,
  unit: string,
  argv: readonly string[],
  vars: [string, string][],
): void {
  const environment = vars.map(
    ([name, value]) => `Environment=${unitWord(`${name}=${value}`)}\n`,
  );
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(
    unit,
    `[Unit]
Description=lmsk masking proxy for Claude Code

[Service]
ExecStart=${argv.map((arg) => unitWord(arg.replace(/\$/g, "$$$$"))).join(" ")}
${environment.join("")}Restart=always

[Install]
WantedBy=default.target
`,
  );
  for (const args of [
    ["daemon-reload"],
    ["enable", "lmsk.service"],
    ["restart", "lmsk.service"],
  ])
    check(run("systemctl", ["--user", ...args]), `systemctl ${args[0]}`);
}

function install(options: InstallOptions): void {
  const { home, env, platform, node, bin } = options;
  if (platform !== "darwin" && platform !== "linux")
    throw new CodedError(
      "PLATFORM_UNSUPPORTED",
      "lmsk runs on macOS and Linux",
    );
  const file = join(
    env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    "settings.json",
  );
  const settings = readSettings(file);
  const paths = machinePaths(env, home);
  const url = `http://127.0.0.1:${SERVE_PORT}/${serveToken(paths.stateDir)}`;
  const deny = protectedPatterns([paths.configPath], {
    rules: [],
    protectedPaths: paths.protectedPaths,
    tools: TOOLS,
  }).flatMap((pattern) => {
    const path = `/${pattern.startsWith("/") ? "" : "/"}${pattern}`;
    return [`Read(${path})`, `Edit(${path})`];
  });
  const next = installedSettings(settings, url, deny, options);
  const gateway = [
    record(settings.env, "env").ANTHROPIC_BASE_URL,
    env.ANTHROPIC_BASE_URL,
  ].find(
    (value) =>
      typeof value === "string" &&
      value !== "" &&
      !value.startsWith(`http://127.0.0.1:${SERVE_PORT}/`),
  );
  if (typeof gateway === "string") saveUpstream(paths.stateDir, gateway);
  const argv = [node, bin, "serve"];
  const vars = (["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const).flatMap(
    (name): [string, string][] => {
      const value = env[name];
      return value ? [[name, value]] : [];
    },
  );
  if (platform === "darwin")
    launchdService(
      options,
      paths.launchdPath,
      argv,
      vars,
      join(paths.stateDir, "serve.log"),
    );
  else systemdService(options, paths.systemdPath, argv, vars);
  writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Starts the proxy at login and points the user settings of Claude Code at it. Returns the exit
 * code. Project settings outrank user settings, so a project can still send Claude Code elsewhere.
 */
export function installClaude(options: InstallOptions): number {
  try {
    install(options);
  } catch (error) {
    if (!(error instanceof CodedError)) throw error;
    options.notify(`lmsk: ${error.message}.`, "error");
    return 1;
  }
  options.notify(
    "lmsk: Claude Code now sends its requests through the proxy. Restart the Claude Code sessions that run.",
    "info",
  );
  return 0;
}
