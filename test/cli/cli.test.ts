import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.ts";

async function run(
  args: string[],
  stdin = "",
  env: Record<string, string> = {},
) {
  const out = { stdout: "", stderr: "" };
  const home = mkdtempSync(join(tmpdir(), "lmsk-cli-"));
  const code = await main(args, {
    cwd: home,
    home,
    env,
    stdin: Readable.from([stdin]),
    stdout: { write: (text: string) => (out.stdout += text) },
    stderr: { write: (text: string) => (out.stderr += text) },
  });
  return { code, ...out };
}

const hookInput = (tool_name: string, tool_input: object) =>
  JSON.stringify({
    cwd: "/w",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
  });

describe("lmsk", () => {
  it("prints the usage on --help and fails with it on an unknown command", async () => {
    expect(await run(["--help"])).toEqual({
      code: 0,
      stdout: expect.stringContaining("lmsk claude"),
      stderr: "",
    });
    expect(await run(["nope"])).toEqual({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("lmsk claude"),
    });
  });

  it("runs the Claude Code hook on its stdin and prints the denial", async () => {
    const claude = await run(
      ["hook", "claude"],
      hookInput("Read", { file_path: "/w/.env" }),
    );
    expect(claude.code).toBe(0);
    expect(
      JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  it("blocks the tool call with exit code 2 when the hook fails, because other codes let it run", async () => {
    expect(await run(["hook", "claude"], "not json")).toEqual({
      code: 2,
      stdout: "",
      stderr: expect.stringMatching(/^lmsk: /),
    });
    expect((await run(["hook", "claude"], "{}")).stderr).toBe(
      "lmsk: hook failed: HOOK_INPUT.\n",
    );
  });

  it("launches Claude Code and returns its exit code", async () => {
    const bin = mkdtempSync(join(tmpdir(), "lmsk-cli-bin-"));
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 7\n");
    chmodSync(join(bin, "claude"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect((await run(["claude", "-p", "x"], "", env)).code).toBe(7);
  });
});
