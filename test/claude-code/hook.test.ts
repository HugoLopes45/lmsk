import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHook } from "../../src/claude-code/index.ts";

describe("claudeHook", () => {
  const home = mkdtempSync(join(tmpdir(), "lmsk-claude-code-hook-"));

  it.each([
    ["Read", { file_path: "/w/.env" }, true],
    ["Bash", { command: "cat .env" }, true],
    ["Bash", { command: "cat .e''nv" }, true],
    ["Bash", { command: 'cat .e"nv"' }, true],
    ["Bash", { command: "cat .en\\v" }, true],
    ["Bash", { command: "cat .e$'n'v" }, true],
    ["Bash", { command: "cat .e\\\nnv" }, true],
    ["Bash", { command: "cat ~/.aws''/credentials" }, true],
    ["Bash", { command: 'cat ~/.aws/"credentials"' }, true],
    ["Bash", { command: "od -c ~/.local/state/lmsk/key" }, true],
    ["Bash", { command: "od -c $HOME/.local/state/lmsk/key" }, true],
    ["Bash", { command: 'od -c "${HOME}"/.local/state/lmsk/key' }, true],
    ["Bash", { command: 'cat "READ"ME.md' }, false],
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
