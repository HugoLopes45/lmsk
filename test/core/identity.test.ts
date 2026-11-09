import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  userInfo: () => {
    throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
  },
}));

const { localIdentityRules } = await import("../../src/core/identity.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localIdentityRules", () => {
  it("returns the other values when the user has no passwd entry", () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    expect(localIdentityRules()).toMatchObject([
      { id: "local-identity", values: [expect.any(String)] },
    ]);
  });
});
