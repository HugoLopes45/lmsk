import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { machinePaths, protectedPath } from "../../src/core/index.ts";
import { searchedPath } from "../../src/core/tool-policy.ts";

describe("machinePaths", () => {
  it("uses the XDG defaults under home and protects lmsk's state and pi's stores and configurations", () => {
    expect(machinePaths({}, "/h")).toEqual({
      configPath: "/h/.config/lmsk/config.json",
      stateDir: "/h/.local/state/lmsk",
      protectedPaths: [
        "/h/.config/lmsk",
        "/h/.config/lmsk/**",
        "/h/.local/state/lmsk",
        "/h/.local/state/lmsk/**",
        "**/lmsk-vaults/**",
        "**/lmsk/config.json",
        "**/lmsk/key",
        "**/lmsk/key.*.tmp",
        "**/lmsk/vault.jsonl",
        "**/lmsk/vault.lock",
        "**/lmsk/vault.lock/**",
        "**/lmsk/session-vaults/**",
        "**/lmsk/serve-token",
        "**/lmsk/upstream",
        "**/.claude/settings*.json",
        "/h/.claude/settings*.json",
        "/h/Library/LaunchAgents/io.github.hugolopes45.lmsk.plist",
        "/h/.config/systemd/user/lmsk.service",
        join(process.cwd(), "dist", "**"),
      ],
      launchdPath: "/h/Library/LaunchAgents/io.github.hugolopes45.lmsk.plist",
      systemdPath: "/h/.config/systemd/user/lmsk.service",
    });
  });

  it.each(["vault.jsonl", "vault.lock/1-a", "session-vaults/ab12/key"])(
    "protects the state file %s also outside the state folder",
    (file) => {
      const { protectedPaths } = machinePaths({}, "/h");
      expect(protectedPath([`/x/lmsk/${file}`], "/", protectedPaths)).toBe(
        `/x/lmsk/${file}`,
      );
    },
  );

  it.each(["/h/a[b]", "/h/a*{x,y}?", "/h/+(a)", "/h/a\\b", "/h/a,.b"])(
    "protects lmsk's files under a home with glob characters: %s",
    (home) => {
      const { stateDir, protectedPaths } = machinePaths({}, home);
      for (const file of [
        `${stateDir}/key`,
        stateDir,
        `${home}/.config/lmsk/rules.txt`,
        `${home}/.claude/settings.local.json`,
        `${home}/Library/LaunchAgents/io.github.hugolopes45.lmsk.plist`,
        `${home}/.config/systemd/user/lmsk.service`,
      ])
        expect(protectedPath([file], "/", protectedPaths)).toBe(file);
      // A search of the home or of a folder above the state folder reads the key.
      for (const root of [home, `${home}/.local`])
        expect(searchedPath([root], "/", protectedPaths)).toBe(root);
    },
  );

  it("protects the code of lmsk installed in a folder with glob characters", async () => {
    vi.resetModules();
    const url = await vi.importActual<typeof import("node:url")>("node:url");
    const root = url.fileURLToPath(new URL("../../", import.meta.url));
    vi.doMock("node:url", () => ({
      ...url,
      fileURLToPath: (path: URL) =>
        url.fileURLToPath(path).replace(root, "/h/a[b]/lmsk/"),
    }));
    const paths = await import("../../src/core/paths.ts");
    vi.doUnmock("node:url");
    const file = "/h/a[b]/lmsk/dist/core/vault.js";
    expect(
      protectedPath([file], "/", paths.machinePaths({}, "/h").protectedPaths),
    ).toBe(file);
  });

  it("protects the temporary key file that a crash leaves in the state folder", () => {
    const { protectedPaths } = machinePaths({}, "/h");
    const temporary =
      "/h/.local/state/lmsk/key.0123456789abcdef0123456789abcdef.tmp";
    expect(protectedPath([temporary], "/", protectedPaths)).toBe(temporary);
  });

  it("ignores a relative CLAUDE_CONFIG_DIR, which no absolute path matches", () => {
    const { protectedPaths } = machinePaths({ CLAUDE_CONFIG_DIR: "rel" }, "/h");
    expect(protectedPaths.filter((path) => path.startsWith("rel"))).toEqual([]);
    expect(protectedPaths).toContain("/h/.claude/settings*.json");
  });

  it("protects the Claude Code settings in CLAUDE_CONFIG_DIR and the service file in XDG_CONFIG_HOME", () => {
    const paths = machinePaths(
      { CLAUDE_CONFIG_DIR: "/cc", XDG_CONFIG_HOME: "/cfg" },
      "/h",
    );
    expect(paths.protectedPaths).toEqual(
      expect.arrayContaining([
        "/cc/settings*.json",
        "/cfg/systemd/user/lmsk.service",
      ]),
    );
  });

  it("uses absolute XDG directories and ignores relative ones, as the XDG specification requires", () => {
    const paths = machinePaths(
      { XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "state" },
      "/h",
    );
    expect(paths.configPath).toBe("/cfg/lmsk/config.json");
    expect(paths.stateDir).toBe("/h/.local/state/lmsk");
  });
});
