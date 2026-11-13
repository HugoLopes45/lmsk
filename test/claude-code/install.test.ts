import {
  existsSync,
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
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installClaude,
  SERVE_PORT,
  serveClaude,
} from "../../src/claude-code/index.ts";

const NODE = "/opt/node/bin/node";
const BIN = "/opt/lmsk/dist/cli/bin.js";
const LABEL = "io.github.hugolopes45.lmsk";
function servicePath(home: string, platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    : join(home, ".config", "systemd", "user", "lmsk.service");
}

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
  const questions: string[] = [];
  let answer = false;
  const accept = () => {
    answer = true;
  };
  const decline = () => {
    answer = false;
  };
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
      confirm: async (question) => {
        questions.push(question);
        return answer;
      },
    });
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  return {
    home,
    file,
    calls,
    notices,
    status,
    questions,
    accept,
    decline,
    install,
    read,
  };
}

describe("installClaude", () => {
  it("points Claude Code at the URL that the proxy serves, and keeps the other settings", async () => {
    const { home, file, accept, install, read } = setup(
      JSON.stringify({
        model: "opus",
        env: { FOO: "1" },
        permissions: { allow: ["Bash(ls)"], deny: ["Read(./x)"] },
        hooks: { PostToolUse: [{ matcher: "*", hooks: [] }] },
      }),
    );
    accept();

    expect(await install()).toBe(0);
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

  it("installs again without a second hook, NO_PROXY entry or deny rule, also from another path", async () => {
    const other = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "x" }],
    };
    const moved = {
      ...HOOK,
      hooks: [{ ...HOOK.hooks[0], args: ["/old/bin.js", "hook", "claude"] }],
    };
    const { accept, install, read } = setup(
      JSON.stringify({
        env: { NO_PROXY: "corp.test" },
        hooks: { PreToolUse: [other, moved] },
      }),
    );

    accept();

    expect(await install()).toBe(0);
    expect(await install()).toBe(0);

    const settings = read();
    expect(settings.hooks.PreToolUse).toEqual([other, HOOK]);
    expect(settings.env.NO_PROXY).toBe("corp.test,127.0.0.1");
    expect(settings.permissions.deny.length, "no deny rule twice").toBe(
      new Set(settings.permissions.deny).size,
    );
  });

  it("keeps a hook of the user that shares a group with the lmsk hook", async () => {
    const mine = { type: "command", command: "audit" };
    const { accept, install, read } = setup(
      JSON.stringify({
        hooks: { PreToolUse: [{ ...HOOK, hooks: [HOOK.hooks[0], mine] }] },
      }),
    );

    accept();

    expect(await install()).toBe(0);

    expect(read().hooks.PreToolUse).toEqual([{ ...HOOK, hooks: [mine] }, HOOK]);
  });

  it("keeps a settings symlink, as dotfile managers make, and updates the file that it points at", async () => {
    const { home, file, accept, install, read } = setup();
    const target = join(home, "dotfiles.json");
    writeFileSync(target, JSON.stringify({ model: "opus" }));
    mkdirSync(join(home, ".claude"));
    symlinkSync(target, file);

    accept();

    expect(await install()).toBe(0);

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
    const { home, accept, install, read } = setup(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }),
    );
    accept();

    expect(await install()).toBe(0);
    expect(await install()).toBe(0);
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

  it("starts the proxy at login with launchd on macOS, in the state directory of the install", async () => {
    const state = mkdtempSync(join(tmpdir(), "lmsk-install-state-"));
    const { home, calls, accept, status, install } = setup(undefined, {
      XDG_STATE_HOME: state,
    });
    accept();
    // Nothing to stop on a first install.
    status.set("bootout", 3);

    expect(await install()).toBe(0);

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

  it("starts the proxy at login with systemd on Linux", async () => {
    const { home, calls, accept, install } = setup(undefined, {}, "linux");
    accept();

    expect(await install()).toBe(0);

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

  it("gives the systemd service the state directory of the install as written", async () => {
    const state = join(mkdtempSync(join(tmpdir(), "lmsk-install-")), "a $b%c");
    const { home, accept, install } = setup(
      undefined,
      { XDG_STATE_HOME: state },
      "linux",
    );
    accept();

    expect(await install()).toBe(0);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "lmsk.service"),
      "utf8",
    );
    // systemd expands `%` specifiers in Environment=, but not `$`.
    expect(unit).toContain(
      `Environment="XDG_STATE_HOME=${state.replace("%", "%%")}"`,
    );
  });

  it("gives the systemd service a node path with a dollar sign as written", async () => {
    const { home, accept, install } = setup(
      undefined,
      {},
      "linux",
      "/opt/a$b/node",
    );
    accept();

    expect(await install()).toBe(0);

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
    async (_case, settings, platform) => {
      const { file, calls, notices, install } = setup(settings, {}, platform);

      expect(await install()).toBe(1);

      expect(readFileSync(file, "utf8")).toBe(settings);
      expect(calls).toEqual([]);
      expect(notices).toEqual([expect.stringMatching(/^lmsk: /)]);
    },
  );

  it("refuses a first install that saves a gateway without a yes, and writes nothing", async () => {
    const { home, file, calls, notices, questions, install } = setup(
      undefined,
      { ANTHROPIC_BASE_URL: "https://gateway.invalid" },
      "linux",
    );
    const service = servicePath(home, "linux");

    expect(await install()).toBe(1);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(home, ".local", "state", "lmsk"))).toBe(false);
    expect(existsSync(service)).toBe(false);
    expect(calls).toEqual([]);
    expect(questions).toEqual([
      `lmsk install sends Claude Code requests to https://gateway.invalid and changes ${service}. Continue?`,
    ]);
    expect(notices).toEqual([
      expect.stringMatching(/^lmsk: INSTALL_NOT_CONFIRMED: /),
    ]);
  });

  it.each(["darwin", "linux"] as const)(
    "refuses a first %s service install without a yes, and writes nothing",
    async (platform) => {
      const { home, file, calls, notices, questions, install } = setup(
        undefined,
        {},
        platform,
      );
      const service = servicePath(home, platform);

      expect(await install()).toBe(1);

      expect(existsSync(service)).toBe(false);
      expect(existsSync(file)).toBe(false);
      expect(calls).toEqual([]);
      expect(questions).toEqual([`lmsk install changes ${service}. Continue?`]);
      expect(notices).toEqual([
        expect.stringMatching(/^lmsk: INSTALL_NOT_CONFIRMED: /),
      ]);
    },
  );

  it("saves the gateway of a first install after a yes", async () => {
    const { home, accept, install } = setup(
      undefined,
      { ANTHROPIC_BASE_URL: "https://gateway.invalid" },
      "linux",
    );
    accept();

    expect(await install()).toBe(0);

    expect(
      readFileSync(join(home, ".local", "state", "lmsk", "upstream"), "utf8"),
    ).toBe("https://gateway.invalid");
  });

  it("refuses to change the saved gateway without a yes, and leaves the service and the settings as they are", async () => {
    const { home, file, calls, notices, questions, install } = setup(
      undefined,
      { ANTHROPIC_BASE_URL: "https://gateway.invalid" },
      "linux",
    );
    const upstream = join(home, ".local", "state", "lmsk", "upstream");
    mkdirSync(dirname(upstream), { recursive: true });
    writeFileSync(upstream, "https://old.invalid");

    expect(await install()).toBe(1);

    expect(readFileSync(upstream, "utf8")).toBe("https://old.invalid");
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
    expect(questions).toEqual([
      expect.stringContaining("https://gateway.invalid"),
    ]);
    expect(questions.join("")).not.toContain("old.invalid");
    expect(notices).toEqual([
      expect.stringMatching(/^lmsk: INSTALL_NOT_CONFIRMED: /),
    ]);
  });

  it("changes the saved gateway after a yes", async () => {
    const { home, accept, install } = setup(
      undefined,
      { ANTHROPIC_BASE_URL: "https://gateway.invalid" },
      "linux",
    );
    const upstream = join(home, ".local", "state", "lmsk", "upstream");
    mkdirSync(dirname(upstream), { recursive: true });
    writeFileSync(upstream, "https://old.invalid");
    accept();

    expect(await install()).toBe(0);

    expect(readFileSync(upstream, "utf8")).toBe("https://gateway.invalid");
  });

  it("repairs an empty saved upstream after a yes", async () => {
    const { home, accept, install } = setup(
      undefined,
      { ANTHROPIC_BASE_URL: "https://gateway.invalid" },
      "linux",
    );
    const upstream = join(home, ".local", "state", "lmsk", "upstream");
    mkdirSync(dirname(upstream), { recursive: true });
    writeFileSync(upstream, "");
    accept();

    expect(await install()).toBe(0);

    expect(readFileSync(upstream, "utf8")).toBe("https://gateway.invalid");
  });

  it("asks nothing when the gateway is the saved one and the service file is unchanged", async () => {
    const env = { ANTHROPIC_BASE_URL: "https://gateway.invalid" };
    const { questions, accept, decline, install } = setup(
      undefined,
      env,
      "linux",
    );
    accept();
    expect(await install()).toBe(0);
    expect(questions).toHaveLength(1);
    decline();

    expect(await install()).toBe(0);

    expect(questions).toHaveLength(1);
  });

  it.each(["darwin", "linux"] as const)(
    "refuses to change the folders of the %s service without a yes",
    async (platform) => {
      const env: Record<string, string> = {};
      const { home, calls, notices, questions, accept, decline, install } =
        setup(undefined, env, platform);
      accept();
      expect(await install()).toBe(0);
      expect(questions).toHaveLength(1);
      decline();
      expect(await install()).toBe(0);
      expect(questions, "an identical rerun asks nothing").toHaveLength(1);
      const service = servicePath(home, platform);
      const before = readFileSync(service, "utf8");
      const ran = calls.length;
      env.XDG_STATE_HOME = join(home, "elsewhere");

      expect(await install()).toBe(1);

      expect(readFileSync(service, "utf8")).toBe(before);
      expect(calls).toHaveLength(ran);
      expect(existsSync(join(home, "elsewhere"))).toBe(false);
      expect(questions).toHaveLength(2);
      expect(notices.at(-1)).toMatch(/^lmsk: INSTALL_NOT_CONFIRMED: /);
    },
  );

  it("writes a changed service file after a yes, and starts the service again", async () => {
    const env: Record<string, string> = {};
    const { home, calls, accept, install } = setup(undefined, env, "linux");
    accept();
    expect(await install()).toBe(0);
    const state = join(home, "elsewhere");
    const ran = calls.length;
    env.XDG_STATE_HOME = state;

    expect(await install()).toBe(0);

    expect(readFileSync(servicePath(home, "linux"), "utf8")).toContain(
      `Environment="XDG_STATE_HOME=${state}"`,
    );
    expect(calls.slice(ran)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "lmsk.service"],
      ["systemctl", "--user", "restart", "lmsk.service"],
    ]);
  });

  it.each(["\n", "\r"])(
    "refuses a service folder with %j in it",
    async (char) => {
      const { home, calls, notices, install } = setup(
        undefined,
        { XDG_STATE_HOME: `/tmp/a${char}ExecStartPre=/bin/false` },
        "linux",
      );

      expect(await install()).toBe(1);

      expect(calls).toEqual([]);
      expect(notices).toEqual([
        expect.stringMatching(/^lmsk: SERVICE_VALUE_INVALID: /),
      ]);
      expect(
        existsSync(join(home, ".config", "systemd", "user", "lmsk.service")),
      ).toBe(false);
    },
  );

  it("leaves the settings as they are when the proxy does not start", async () => {
    const { file, notices, accept, status, install } = setup("{}");
    accept();
    status.set("bootstrap", 5);

    expect(await install()).toBe(1);

    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(notices).toEqual([expect.stringMatching(/^lmsk: /)]);
  });
});
