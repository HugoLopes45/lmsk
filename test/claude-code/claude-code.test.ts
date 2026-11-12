import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeProfile, launchClaude } from "../../src/claude-code/index.ts";

const REAL = "Zq7Kp2Lm9Xw4Rt8Vb3Nc";

describe("claudeProfile", () => {
  const profile = claudeProfile({ cwd: "/w", env: {}, protectedPaths: [] });

  it("reads the path of each built-in file tool and the command of Bash", () => {
    expect(profile.pathOf("Read", { file_path: "/a" })).toBe("/a");
    expect(profile.pathOf("Edit", { file_path: "/b" })).toBe("/b");
    expect(profile.pathOf("Grep", { pattern: "x", path: "/c" })).toBe("/c");
    expect(profile.pathOf("Bash", { command: "cat /d" })).toBeUndefined();
    expect(profile.pathOf("mcp__x__Read", { file_path: "/e" })).toBeUndefined();
    expect(profile.commandKey("Bash")).toBe("command");
    expect(profile.commandKey("Read")).toBeUndefined();
  });

  it("forwards to the agent's own ANTHROPIC_BASE_URL, else to Anthropic", () => {
    expect(profile.upstream({})).toBe("https://api.anthropic.com");
    expect(
      claudeProfile({
        cwd: "/w",
        env: { ANTHROPIC_BASE_URL: "" },
        protectedPaths: [],
      }).upstream({}),
    ).toBe("https://api.anthropic.com");
    expect(
      claudeProfile({
        cwd: "/w",
        env: { ANTHROPIC_BASE_URL: "https://gateway.test" },
        protectedPaths: [],
      }).upstream({}),
    ).toBe("https://gateway.test");
  });
});

// The uuid rule matches it, so only the profile's kept headers let it through.
const SESSION = "0b7e4f2a-3c1d-4e5f-8a9b-1c2d3e4f5a6b";

/** A `claude` stand-in: sends one Messages request through ANTHROPIC_BASE_URL, saves its argv, exits 3. */
function fakeClaude(dir: string): void {
  const script = `#!/usr/bin/env node
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const text = "API_KEY=${REAL}";
const body = {
  system: [{ type: "text", text }],
  messages: [
    { role: "user", content: text },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
  ],
};
fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-claude-code-session-id": "${SESSION}" },
  body: JSON.stringify(body),
}).then(async (res) => {
  const settings = process.argv[process.argv.indexOf("--settings") + 1];
  writeFileSync(${JSON.stringify(join(dir, "out.json"))}, JSON.stringify({
    argv: process.argv.slice(2),
    status: res.status,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    settings: JSON.parse(readFileSync(settings, "utf8")),
    mode: statSync(settings).mode & 0o777,
  }));
  if (process.env.FAKE_WAIT) setInterval(() => undefined, 1000);
  else process.exit(3);
});
`;
  const path = join(dir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** An upstream that records each body and calls `onRequest` after it answers. */
async function upstream(
  onRequest: () => void = () => undefined,
): Promise<{ url: string; bodies: string[]; close(): void }> {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}", onRequest);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("upstream has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => server.close(),
  };
}

describe("launchClaude", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("closes the proxy when the settings file cannot be written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
    const close = vi.spyOn(Server.prototype, "close");
    vi.stubEnv("TMPDIR", join(dir, "missing"));

    await expect(
      launchClaude([], {
        cwd: dir,
        home: dir,
        env: { PATH: dir },
        notify: () => undefined,
      }),
    ).rejects.toThrow("ENOENT");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("says that claude is not on the PATH, and exits 127 as a shell does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
    const notices: unknown[][] = [];

    const code = await launchClaude([], {
      cwd: dir,
      home: dir,
      env: { PATH: dir },
      notify: (...notice) => notices.push(notice),
    });

    expect(code).toBe(127);
    expect(notices).toEqual([["lmsk: claude is not on your PATH.", "error"]]);
  });

  it("survives the terminal's SIGINT, which claude gets itself, and forwards SIGTERM to claude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
    fakeClaude(dir);
    // The handler runs once claude waits, so the signals reach a running launcher.
    const up = await upstream(() => {
      setTimeout(() => {
        process.kill(process.pid, "SIGINT");
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
      }, 100);
    });

    const code = await launchClaude([], {
      cwd: dir,
      home: dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        ANTHROPIC_BASE_URL: up.url,
        FAKE_WAIT: "1",
      },
      notify: () => undefined,
    });
    up.close();

    expect(code).toBe(128 + 15);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("refuses a --settings of the user, which would replace the settings that route claude through the proxy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
    fakeClaude(dir);
    const messages: string[] = [];

    for (const args of [["--settings", "{}"], ["--settings={}"]]) {
      const code = await launchClaude(args, {
        cwd: dir,
        home: dir,
        env: { PATH: `${dir}:${process.env.PATH}` },
        notify: (message) => messages.push(message),
      });
      expect(code).toBe(1);
    }

    expect(messages).toEqual([
      expect.stringMatching(/^lmsk: --settings/),
      expect.stringMatching(/^lmsk: --settings/),
    ]);
    expect(existsSync(join(dir, "out.json"))).toBe(false);
  });

  it.each([
    ["the local settings", "project/.claude/settings.local.json", {}],
    ["the project settings", "project/.claude/settings.json", {}],
    ["the user settings", "home/.claude/settings.json", {}],
    [
      "the user settings in CLAUDE_CONFIG_DIR",
      "config/settings.json",
      { CLAUDE_CONFIG_DIR: "config" },
    ],
  ])(
    "refuses an ANTHROPIC_BASE_URL in %s, which the proxy would replace with Anthropic's",
    async (_name, file, extra) => {
      const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
      fakeClaude(dir);
      const path = join(dir, file);
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(join(dir, "project"), { recursive: true });
      const url = "https://gateway.test";
      writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
      const env = Object.fromEntries(
        Object.entries(extra).map(([name, value]) => [name, join(dir, value)]),
      );
      const messages: string[] = [];

      const code = await launchClaude([], {
        cwd: join(dir, "project"),
        home: join(dir, "home"),
        env: { ...env, PATH: `${dir}:${process.env.PATH}` },
        notify: (message) => messages.push(message),
      });

      expect(code).toBe(1);
      expect(messages).toEqual([
        `lmsk: ${path} sets ANTHROPIC_BASE_URL. Set it in the environment of lmsk instead, so that the proxy forwards to it.`,
      ]);
      expect(existsSync(join(dir, "out.json"))).toBe(false);
    },
  );

  it("starts claude with settings files that set no gateway or do not load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
    fakeClaude(dir);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ env: { FOO: "1", ANTHROPIC_BASE_URL: "" } }),
    );
    // Claude Code 2.1.319 loads nothing from a file with a comment or a trailing comma.
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      '// note\n{"env":{"ANTHROPIC_BASE_URL":"https://gateway.test"}}',
    );

    const code = await launchClaude([], {
      cwd: dir,
      home: dir,
      // A closed port, so that the fake request goes nowhere.
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      },
      notify: () => undefined,
    });

    expect(code).toBe(3);
  });

  it("runs claude behind the proxy: the provider gets same-length fakes, claude gets its arguments and its exit code is returned", async () => {
    const bodies: string[] = [];
    const sessionIds: unknown[] = [];
    const upstream = createServer(async (req, res) => {
      sessionIds.push(req.headers["x-claude-code-session-id"]);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (address === null || typeof address === "string")
      throw new Error("upstream has no TCP address");
    const { port } = address;
    const dir = mkdtempSync(join(tmpdir(), "lmsk-claude-"));
    fakeClaude(dir);

    const code = await launchClaude(["-p", "hi"], {
      cwd: dir,
      home: dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
      notify: () => undefined,
    });
    upstream.close();

    expect(code).toBe(3);
    expect(sessionIds).toEqual([SESSION]);
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(out).toMatchObject({
      argv: [
        "--plugin-dir",
        fileURLToPath(new URL("../../plugin", import.meta.url)),
        "--settings",
        expect.any(String),
        "-p",
        "hi",
      ],
      status: 200,
      mode: 0o600,
    });
    // Settings `env` overrides the process environment and project settings; "" unsets a provider switch. A project NO_PROXY without the loopback address would send the request to its HTTP_PROXY.
    expect(out.settings.env).toEqual({
      ANTHROPIC_BASE_URL: out.baseUrl,
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
      CLAUDE_CODE_USE_MANTLE: "",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
    });
    // Flag settings outrank project settings, so a repository cannot turn off the deny hook.
    expect(out.settings.disableAllHooks).toBe(false);
    expect(out.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{43}$/);
    // The file holds the launch token, so it lives only as long as claude.
    expect(existsSync(out.argv[3])).toBe(false);
    expect(out.settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(//**/.env*)",
        `Read(/${dir}/.config/lmsk/**)`,
      ]),
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(REAL);
    expect(bodies[0].match(/API_KEY=([^"]*)/g)).toEqual([
      expect.stringMatching(new RegExp(`^API_KEY=.{${REAL.length}}$`)),
      expect.anything(),
      expect.anything(),
    ]);
  });
});
