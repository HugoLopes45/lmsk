import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { machinePaths, protectedPath } from "../../src/core/index.ts";

describe("machinePaths", () => {
  it("uses the XDG defaults under home and protects lmsk's state and pi's stores and configurations", () => {
    expect(machinePaths({}, "/h")).toEqual({
      configPath: "/h/.config/lmsk/config.json",
      stateDir: "/h/.local/state/lmsk",
      protectedPaths: [
        "/h/.config/lmsk/**",
        "/h/.local/state/lmsk/**",
        "**/lmsk-vaults/**",
        "**/lmsk/config.json",
        "**/lmsk/key",
        "**/lmsk/vault.jsonl",
        "**/lmsk/vault.lock",
        "**/lmsk/vault.lock/**",
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

  it.each(["vault.jsonl", "vault.lock/1-a"])(
    "protects the state file %s also outside the state folder",
    (file) => {
      const { protectedPaths } = machinePaths({}, "/h");
      expect(protectedPath([`/x/lmsk/${file}`], "/", protectedPaths)).toBe(
        `/x/lmsk/${file}`,
      );
    },
  );

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
