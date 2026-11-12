import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProfile, serveClaude } from "../../src/claude-code/index.ts";

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
