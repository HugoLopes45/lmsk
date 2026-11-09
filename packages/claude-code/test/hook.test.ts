import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHook, claudeProfile } from "../src/index.ts";

describe("claudeHook", () => {
  const home = mkdtempSync(join(tmpdir(), "lmsk-claude-code-hook-"));

  it("runs for each tool that the proxy restores", () => {
    const hooks = JSON.parse(
      readFileSync(
        new URL("../plugin/hooks/hooks.json", import.meta.url),
        "utf8",
      ),
    );
    const { tools } = claudeProfile({ cwd: "/w", env: {}, protectedPaths: [] });

    expect(hooks.hooks.PreToolUse[0].matcher.split("|").toSorted()).toEqual(
      [...tools].toSorted(),
    );
  });

  it.each([
    ["Read", { file_path: "/w/.env" }, true],
    ["Bash", { command: "cat .env" }, true],
    ["Read", { file_path: "/w/README.md" }, false],
    ["Grep", { pattern: "x", path: "/w/.env.local" }, true],
  ])(
    "denies %s %j when it opens a protected path: %s",
    (tool, toolInput, denied) => {
      const output = claudeHook(
        {
          cwd: "/w",
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: toolInput,
        },
        { env: {}, home },
      );
      expect(
        output === undefined
          ? undefined
          : JSON.parse(output).hookSpecificOutput.permissionDecision,
      ).toBe(denied ? "deny" : undefined);
    },
  );
});
