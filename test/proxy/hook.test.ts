import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandWords, type HookOptions, hookDenial } from "../../src/proxy/index.ts";

function options(config: unknown = {}): HookOptions {
  const configPath = join(mkdtempSync(join(tmpdir(), "lmsk-hook-")), "c.json");
  writeFileSync(configPath, JSON.stringify(config));
  return {
    configPath,
    home: "/h",
    protectedPaths: ["**/own-state/**", "/h/state/**"],
    tools: ["Read"],
    targets: (tool, input) =>
      tool === "Read" && typeof input.file_path === "string"
        ? [input.file_path]
        : [],
  };
}

const call = (file_path: string, cwd = "/w") => ({
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path },
});

describe("hookDenial", () => {
  it("denies a call whose target is protected, by default or by the host, relative to the call's cwd", () => {
    for (const [path, cwd] of [
      [".env", "/w"],
      ["/x/own-state/a", "/w"],
      ["a", "/x/own-state"],
    ])
      expect(JSON.parse(hookDenial(call(path, cwd), options()) ?? "")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `lmsk: ${path} is a protected path`,
        },
      });
  });

  it("reads a target that starts with ~ from home, as the shell does", () => {
    expect(hookDenial(call("~/state/v.json"), options())).toBeDefined();
    expect(hookDenial(call("~state/v.json", "/h"), options())).toBeUndefined();
  });

  it("allows a call without a protected target", () => {
    expect(hookDenial(call("README.md"), options())).toBeUndefined();
  });

  it("follows the configured protected paths", () => {
    const config = { protectedPaths: ["**/notes.txt", "!**/.env*"] };
    expect(hookDenial(call("notes.txt"), options(config))).toBeDefined();
    expect(hookDenial(call(".env"), options(config))).toBeUndefined();
  });

  it("rejects an input that is not a tool call hook input", () => {
    for (const input of [
      null,
      { ...call(".env"), cwd: 1 },
      { ...call(".env"), tool_input: "x" },
    ])
      expect(() => hookDenial(input, options())).toThrow("HOOK_INPUT");
  });
});

describe("commandWords", () => {
  it("splits a shell command at blanks, operators and quotes", () => {
    expect(commandWords(`cat .env|grep "a b";ls>out`)).toEqual([
      "cat",
      ".env",
      "grep",
      "a",
      "b",
      "ls",
      "out",
    ]);
  });
});
