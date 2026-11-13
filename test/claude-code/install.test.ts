import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installClaude,
  SERVE_PORT,
  serveClaude,
} from "../../src/claude-code/index.ts";

const NODE = "/opt/node/bin/node";
const BIN = "/opt/lmsk/dist/cli/bin.js";
const LABEL = "io.github.hugolopes45.lmsk";
const HOOK = {
  matcher: "Read|Write|Edit|Grep|Glob|NotebookEdit|MultiEdit|Bash",
  hooks: [
    {
      type: "command",
      command: NODE,
      args: [BIN, "hook", "claude"],
      onFailure: "block",
    },
  ],
};

function setup(
  settings?: string,
  env: Record<string, string> = {},
  platform: NodeJS.Platform = "darwin",
  node = NODE,
) {
  const home = mkdtempSync(join(tmpdir(), "lmsk-install-"));
  const file = join(home, ".claude", "settings.json");
  if (settings !== undefined) {
    mkdirSync(join(home, ".claude"));
    writeFileSync(file, settings);
  }
  const calls: string[][] = [];
  const notices: string[] = [];
  const status = new Map<string, number>();
  const install = () =>
    installClaude({
      home,
      env,
      platform,
      node,
      bin: BIN,
      run: (command, args) => {
        calls.push([command, ...args]);
        return status.get(args[0]) ?? 0;
      },
      notify: (message) => notices.push(message),
    });
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  return { home, file, calls, notices, status, install, read };
}

describe("installClaude", () => {
  it("points Claude Code at the URL that the proxy serves, and keeps the other settings", async () => {
    const { home, file, install, read } = setup(
      JSON.stringify({
        model: "opus",
        env: { FOO: "1" },
        permissions: { allow: ["Bash(ls)"], deny: ["Read(./x)"] },
        hooks: { PostToolUse: [{ matcher: "*", hooks: [] }] },
      }),
    );

    expect(install()).toBe(0);
    const proxy = await serveClaude({
      cwd: home,
      home,
      env: {},
      notify: () => undefined,
      port: 0,
    });
    await proxy.close();

    const settings = read();
    const url = new URL(settings.env.ANTHROPIC_BASE_URL);
    expect(url.host).toBe(`127.0.0.1:${SERVE_PORT}`);
    expect(url.pathname).toBe(new URL(proxy.url).pathname);
    expect(settings).toMatchObject({
      model: "opus",
      env: {
        FOO: "1",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
        CLAUDE_CODE_USE_BEDROCK: "",
        CLAUDE_CODE_USE_VERTEX: "",
        CLAUDE_CODE_USE_FOUNDRY: "",
        CLAUDE_CODE_USE_MANTLE: "",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
      },
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PostToolUse: [{ matcher: "*", hooks: [] }] },
    });
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(./x)",
        "Read(//**/.env*)",
        `Read(/${home}/.local/state/lmsk/**)`,
        "Edit(//**/.env*)",
        `Edit(/${home}/.local/state/lmsk/**)`,
        "Edit(//**/.claude/settings*.json)",
      ]),
    );
    // The file now holds the URL token.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("installs again without a second hook, NO_PROXY entry or deny rule, also from another path", () => {
    const other = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "x" }],
    };
    const moved = {
      ...HOOK,
      hooks: [{ ...HOOK.hooks[0], args: ["/old/bin.js", "hook", "claude"] }],
    };
    const { install, read } = setup(
      JSON.stringify({
        env: { NO_PROXY: "corp.test" },
        hooks: { PreToolUse: [other, moved] },
      }),
    );

    expect(install()).toBe(0);
    expect(install()).toBe(0);

    const settings = read();
    expect(settings.hooks.PreToolUse).toEqual([other, HOOK]);
    expect(settings.env.NO_PROXY).toBe("corp.test,127.0.0.1");
    expect(settings.permissions.deny.length, "no deny rule twice").toBe(
      new Set(settings.permissions.deny).size,
    );
  });

  it("keeps a hook of the user that shares a group with the lmsk hook", () => {
    const mine = { type: "command", command: "audit" };
    const { install, read } = setup(
      JSON.stringify({
        hooks: { PreToolUse: [{ ...HOOK, hooks: [HOOK.hooks[0], mine] }] },
      }),
    );

    expect(install()).toBe(0);

    expect(read().hooks.PreToolUse).toEqual([{ ...HOOK, hooks: [mine] }, HOOK]);
  });

  it("keeps a settings symlink, as dotfile managers make, and updates the file that it points at", () => {
    const { home, file, install, read } = setup();
    const target = join(home, "dotfiles.json");
    writeFileSync(target, JSON.stringify({ model: "opus" }));
    mkdirSync(join(home, ".claude"));
    symlinkSync(target, file);

    expect(install()).toBe(0);

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(read()).toMatchObject({ model: "opus", env: expect.anything() });
  });

  it("keeps the gateway that the settings pointed Claude Code at as the upstream of the proxy, also when installed again", async () => {
    const bodies: string[] = [];
    const gateway = createServer((req, res) => {
      void text(req).then((body) => {
        bodies.push(body);
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      gateway.listen(0, "127.0.0.1", resolve),
    );
    const address = gateway.address();
    if (address === null || typeof address === "string")
      throw new Error("gateway has no TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const { home, install, read } = setup(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }),
    );

    expect(install()).toBe(0);
    expect(install()).toBe(0);
    const proxy = await serveClaude({
      cwd: home,
      home,
      env: {},
      notify: () => undefined,
      port: 0,
    });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    await proxy.close();
    gateway.close();

    expect(res.status).toBe(200);
    expect(bodies).toEqual(["{}"]);
    expect(read().env.ANTHROPIC_BASE_URL).not.toBe(url);
  });

  it("starts the proxy at login with launchd on macOS, in the state directory of the install", () => {
    const state = mkdtempSync(join(tmpdir(), "lmsk-install-state-"));
    const { home, calls, status, install } = setup(undefined, {
      XDG_STATE_HOME: state,
    });
    // Nothing to stop on a first install.
    status.set("bootout", 3);

    expect(install()).toBe(0);

    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(
      `<array><string>${NODE}</string><string>${BIN}</string><string>serve</string></array>`,
    );
    expect(text).toContain(
      `<key>XDG_STATE_HOME</key><string>${state}</string>`,
    );
    expect(text).toContain("<key>KeepAlive</key><true/>");
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    const domain = `gui/${process.getuid?.()}`;
    expect(calls).toEqual([
      ["launchctl", "bootout", `${domain}/${LABEL}`],
      ["launchctl", "bootstrap", domain, plist],
    ]);
  });

  it("starts the proxy at login with systemd on Linux", () => {
    const { home, calls, install } = setup(undefined, {}, "linux");

    expect(install()).toBe(0);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "lmsk.service"),
      "utf8",
    );
    expect(unit).toContain(`ExecStart="${NODE}" "${BIN}" "serve"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "lmsk.service"],
      ["systemctl", "--user", "restart", "lmsk.service"],
    ]);
  });

  it("gives the systemd service the state directory of the install as written", () => {
    const state = join(mkdtempSync(join(tmpdir(), "lmsk-install-")), "a $b%c");
    const { home, install } = setup(
      undefined,
      { XDG_STATE_HOME: state },
      "linux",
    );

    expect(install()).toBe(0);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "lmsk.service"),
      "utf8",
    );
    // systemd expands `%` specifiers in Environment=, but not `$`.
    expect(unit).toContain(
      `Environment="XDG_STATE_HOME=${state.replace("%", "%%")}"`,
    );
  });

  it("gives the systemd service a node path with a dollar sign as written", () => {
    const { home, install } = setup(undefined, {}, "linux", "/opt/a$b/node");

    expect(install()).toBe(0);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "lmsk.service"),
      "utf8",
    );
    // systemd substitutes `$` variables in a command line, and `$$` gives one `$`.
    expect(unit).toContain(`ExecStart="/opt/a$$b/node" "${BIN}" "serve"`);
  });

  it.each([
    ["a settings file that is not JSON", "{", "darwin"],
    ["a settings env that is not an object", '{"env":"x"}', "darwin"],
    ["a platform without launchd or systemd", "{}", "win32"],
  ] as const)(
    "refuses %s, and leaves the settings and the service as they are",
    (_case, settings, platform) => {
      const { file, calls, notices, install } = setup(settings, {}, platform);

      expect(install()).toBe(1);

      expect(readFileSync(file, "utf8")).toBe(settings);
      expect(calls).toEqual([]);
      expect(notices).toEqual([expect.stringMatching(/^lmsk: /)]);
    },
  );

  it("leaves the settings as they are when the proxy does not start", () => {
    const { file, notices, status, install } = setup("{}");
    status.set("bootstrap", 5);

    expect(install()).toBe(1);

    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(notices).toEqual([expect.stringMatching(/^lmsk: /)]);
  });
});
