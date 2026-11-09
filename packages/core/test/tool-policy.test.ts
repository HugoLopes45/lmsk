import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtectedPath } from "../src/index.ts";

describe("isProtectedPath", () => {
  it.each([
    ["/home/u/.pi/agent/lmsk-vaults/a.json", "**/lmsk-vaults/**"],
    ["/w/.git/x/.env", "**/.env*"],
    ["/w/.a/b.pem", "**/*.pem"],
    ["/h/.x/.ssh/id", "**/.ssh/**"],
    ["/h/.ssh/.hidden", "**/.ssh/**"],
    ["/w/.npmrc", "**/{.env,.npmrc}"],
  ])(
    "matches %s with %s, also through folders that start with a dot",
    (path, pattern) => {
      expect(isProtectedPath(path, "/", [pattern])).toBe(true);
    },
  );

  it.each([
    ["/w/env", "**/.env*"],
    ["/w/a.pem.txt", "**/*.pem"],
    ["/w/x.env", "**/.env*"],
  ])("does not match %s with %s", (path, pattern) => {
    expect(isProtectedPath(path, "/", [pattern])).toBe(false);
  });

  it.each([
    ["a new file in a linked folder", "link/config.json"],
    ["a new file in a new folder of a linked folder", "link/sub/new.json"],
    ["a link to a file that does not exist yet", "dangling"],
    ["a link whose relative target climbs out of a linked folder", "climb"],
    ["a path that climbs out of a linked folder", "up/../config.json"],
  ])("matches %s by the path that the link leads to", (_name, path) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lmsk-links-")));
    const guarded = join(root, "guarded");
    const repo = join(root, "repo");
    mkdirSync(join(guarded, "deep"), { recursive: true });
    mkdirSync(repo);
    symlinkSync(guarded, join(repo, "link"));
    symlinkSync(join(guarded, "config.json"), join(repo, "dangling"));
    symlinkSync(join(guarded, "deep"), join(repo, "up"));
    // By text, up/.. is the repo; on disk it is the guarded folder.
    symlinkSync("up/../config.json", join(repo, "climb"));

    expect(isProtectedPath(path, repo, [`${guarded}/**`])).toBe(true);
  });

  it("ends on links that lead back to each other", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "lmsk-links-")));
    symlinkSync("c", join(repo, "b"));
    symlinkSync("b/../b", join(repo, "c"));

    expect(isProtectedPath("b/x", repo, ["**/.env"])).toBe(false);
  });

  it("does not match a path under a file, which no tool can open", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "lmsk-links-")));
    writeFileSync(join(repo, "package.json"), "{}");

    expect(isProtectedPath("package.json/x", repo, ["**/.env"])).toBe(false);
  });
});
