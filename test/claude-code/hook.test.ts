import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
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
    ["Bash", { command: "cd ~/.local/state && od -c lmsk/key" }, true],
    [
      "Bash",
      {
        command:
          "cd ~/.local/state && cat lmsk/key.0123456789abcdef0123456789abcdef.tmp",
      },
      true,
    ],
    ["Bash", { command: "cd ~/.local/state/lmsk && cat key" }, true],
    ["Bash", { command: "cd ~/.local/state/lmsk/ && cat key" }, true],
    ["Bash", { command: 'cd "$HOME"/.local/state/lmsk && cat key' }, true],
    ["Bash", { command: "cd ~/.local/state/lmsk/sub && cat key" }, true],
    ["Bash", { command: "cd ~/.local/state/lmsk-other && cat key" }, false],
    ["Bash", { command: "cd ~/.local/state && ls" }, false],
    ["Bash", { command: "cd ~/.config/lmsk && cat config.json" }, true],
    ["Bash", { command: "cd ~/.config/lmsk/ && cat config.json" }, true],
    ["Bash", { command: 'cd "$HOME"/.config/lmsk && cat config.json' }, true],
    ["Bash", { command: "cd ~/.config/lmsk-other && cat config.json" }, false],
    ["Bash", { command: "cat key" }, false],
    [
      "Bash",
      { command: "cat key.0123456789abcdef0123456789abcdef.tmp" },
      false,
    ],
    [
      "Bash",
      {
        command:
          "cd ~/.local/state/lmsk && cat key.0123456789abcdef0123456789abcdef.tmp",
      },
      true,
    ],
    ["Write", { file_path: "/w/.claude/settings.local.json" }, true],
    ["Edit", { file_path: "~/.claude/settings.json" }, true],
    ["Edit", { file_path: "~/.config/systemd/user/lmsk.service" }, true],
    ["Write", { file_path: "/w/.claude/agents/a.md" }, false],
    [
      "Write",
      { file_path: "~/Library/LaunchAgents/io.github.hugolopes45.lmsk.plist" },
      true,
    ],
    ["Edit", { file_path: join(process.cwd(), "dist", "cli", "bin.js") }, true],
    ["Bash", { command: 'cat "READ"ME.md' }, false],
    ["Read", { file_path: "/w/README.md" }, false],
    ["Grep", { pattern: "x", path: "/w/.env.local" }, true],
    ["NotebookEdit", { notebook_path: "/w/.claude/settings.local.json" }, true],
    ["NotebookEdit", { notebook_path: "/w/a.ipynb" }, false],
    ["MultiEdit", { file_path: "~/.claude/settings.json" }, true],
    ["MultiEdit", { file_path: "/w/a.ts" }, false],
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

  describe("a search root", () => {
    const linked = mkdtempSync(join(tmpdir(), "lmsk-claude-code-link-"));
    mkdirSync(join(home, ".local", "state"), { recursive: true });
    symlinkSync(join(home, ".local"), join(linked, "local"));

    it.each([
      ["Grep", { pattern: "x", path: "~" }, "/w", true],
      ["Grep", { pattern: "x", path: "~/" }, "/w", true],
      ["Grep", { pattern: "x", path: "$HOME" }, "/w", true],
      ["Grep", { pattern: "x", path: "${HOME}" }, "/w", true],
      ["Grep", { pattern: "x", path: "~/.local" }, "/w", true],
      ["Grep", { pattern: "x", path: "~/.local/state/lmsk" }, "/w", true],
      ["Grep", { pattern: "x", path: "/" }, "/w", true],
      ["Glob", { pattern: "*", path: "~/.claude" }, "/w", true],
      ["Glob", { pattern: "*", path: "~/.LOCAL" }, "/w", true],
      ["Grep", { pattern: "x", path: "state" }, join(home, ".local"), true],
      ["Grep", { pattern: "x", path: join(linked, "local") }, "/w", true],
      ["Grep", { pattern: "x" }, home, true],
      ["Glob", { pattern: "*" }, home, true],
      ["Grep", { pattern: "x", path: "~/.local/sta" }, "/w", false],
      ["Grep", { pattern: "x", path: "~/src" }, "/w", false],
      ["Grep", { pattern: "x" }, "/w", false],
      ["Glob", { pattern: "*", path: "/w/src" }, "/w", false],
    ])(
      "checks the search root of %s %j from %s, denied: %s",
      (tool, toolInput, cwd, denied) => {
        const output = claudeHook(
          {
            cwd,
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

  it("denies a cd into the config folder under XDG_CONFIG_HOME", () => {
    const output = claudeHook(
      {
        cwd: "/w",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "cd /cfg/lmsk && cat config.json" },
      },
      { env: { XDG_CONFIG_HOME: "/cfg" }, home },
    );
    expect(
      output && JSON.parse(output).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  it("denies an edit of the settings in CLAUDE_CONFIG_DIR", () => {
    const output = claudeHook(
      {
        cwd: "/w",
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/cc/settings.json" },
      },
      { env: { CLAUDE_CONFIG_DIR: "/cc" }, home },
    );
    expect(
      output && JSON.parse(output).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });
});
