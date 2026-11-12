import { describe, expect, it } from "vitest";
import { machinePaths } from "../../src/core/index.ts";

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
      ],
    });
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
