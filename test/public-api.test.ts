import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("published entry", () => {
  it("exports only the names of the supported API", () => {
    const script =
      'console.log(JSON.stringify(Object.keys(await import("@hugolopes45/lmsk")).sort()));';
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([
      "Guard",
      "localIdentityRules",
      "machinePaths",
    ]);
  });

  it("builds the scanner worker next to the scanner", () => {
    expect(existsSync(join(root, "dist/core/scan-worker.mjs"))).toBe(true);
  });
});

describe("README example", () => {
  it("type-checks against the built package", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Use it in your own agent"));
    const example = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    if (example === undefined)
      throw new Error("The README has no ts example in its API section");
    // The folder sits in the package root, so the package name resolves through its exports.
    const dir = mkdtempSync(join(root, ".readme-example-"));
    const file = join(dir, "example.mts");
    try {
      writeFileSync(file, example);
      const result = spawnSync(
        join(root, "node_modules/.bin/tsc"),
        [
          "--noEmit",
          "--ignoreConfig",
          "--strict",
          "--module",
          "nodenext",
          "--target",
          "es2023",
          "--types",
          "node",
          file,
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.error, "tsc did not start").toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
