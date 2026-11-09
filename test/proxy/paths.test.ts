import { describe, expect, it } from "vitest";
import { proxyPaths } from "../../src/proxy/index.ts";

describe("proxyPaths", () => {
  it("uses the XDG defaults under home and protects the proxy's and pi's stores and configurations", () => {
    expect(proxyPaths({}, "/h")).toEqual({
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
    const paths = proxyPaths(
      { XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "state" },
      "/h",
    );
    expect(paths.configPath).toBe("/cfg/lmsk/config.json");
    expect(paths.stateDir).toBe("/h/.local/state/lmsk");
  });
});
