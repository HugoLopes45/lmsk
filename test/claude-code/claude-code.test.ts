import fs, { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeProfile, serveClaude } from "../../src/claude-code/index.ts";
import { serveToken } from "../../src/claude-code/serve.ts";

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
    expect(profile.upstream).toBe("https://api.anthropic.com");
    expect(
      claudeProfile({
        cwd: "/w",
        env: { ANTHROPIC_BASE_URL: "" },
        protectedPaths: [],
      }).upstream,
    ).toBe("https://api.anthropic.com");
    expect(
      claudeProfile({
        cwd: "/w",
        env: { ANTHROPIC_BASE_URL: "https://gateway.test" },
        protectedPaths: [],
      }).upstream,
    ).toBe("https://gateway.test");
  });
});

/** An upstream that records each body. */
async function upstream(): Promise<{
  url: string;
  bodies: string[];
  close(): void;
}> {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
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

describe("serveToken", () => {
  it("refuses an invalid existing token without replacing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-token-"));
    const path = join(dir, "serve-token");
    fs.writeFileSync(path, "incomplete", { mode: 0o600 });
    expect(() => serveToken(dir)).toThrow(
      expect.objectContaining({ code: "TOKEN_CORRUPT" }),
    );
    expect(fs.readFileSync(path, "utf8")).toBe("incomplete");
    expect(fs.readdirSync(dir)).toEqual(["serve-token"]);
  });

  it("shares a complete token with a caller arriving during the first write", () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-token-"));
    const write = fs.writeFileSync;
    let intercepted = false;
    let concurrent: string | undefined;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (intercepted) return write(file, data, options);
      intercepted = true;
      const fd =
        typeof file === "number" ? file : fs.openSync(file, "wx", 0o600);
      try {
        concurrent = serveToken(dir);
        write(fd, data, options);
      } finally {
        if (typeof file !== "number") fs.closeSync(fd);
      }
    });
    syncBuiltinESMExports();
    try {
      const first = serveToken(dir);
      expect(concurrent).toMatch(/^[\w-]{43}$/);
      expect(first).toBe(concurrent);
      expect(serveToken(dir)).toBe(first);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
});

describe("serveClaude", () => {
  const options = (home: string, env: Record<string, string> = {}) => ({
    cwd: home,
    home,
    env,
    notify: () => undefined,
    port: 0,
  });
  const tokenOf = (url: string) => new URL(url).pathname;

  it("keeps the URL token of the machine across restarts, so the settings that hold it stay valid", async () => {
    const home = mkdtempSync(join(tmpdir(), "lmsk-serve-"));
    const first = await serveClaude(options(home));
    await first.close();
    const second = await serveClaude(options(home));
    await second.close();
    const other = await serveClaude(
      options(mkdtempSync(join(tmpdir(), "lmsk-serve-"))),
    );
    await other.close();

    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{43}$/);
    expect(tokenOf(second.url)).toBe(tokenOf(first.url));
    expect(tokenOf(other.url)).not.toBe(tokenOf(first.url));
  });

  it("masks what Claude Code sends before it reaches the upstream", async () => {
    const home = mkdtempSync(join(tmpdir(), "lmsk-serve-"));
    const up = await upstream();
    const proxy = await serveClaude(
      options(home, { ANTHROPIC_BASE_URL: up.url }),
    );

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: `API_KEY=${REAL}` }],
      }),
    });
    await proxy.close();
    up.close();

    expect(res.status).toBe(200);
    expect(up.bodies).toHaveLength(1);
    expect(up.bodies[0]).toContain("API_KEY=");
    expect(up.bodies[0]).not.toContain(REAL);
  });
});
