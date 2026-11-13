import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SERVE_PORT } from "../../src/claude-code/index.ts";
import { confirm, main } from "../../src/cli/main.ts";
import { isRecord } from "../../src/core/index.ts";

async function run(args: string[], stdin = "") {
  const out = { stdout: "", stderr: "" };
  const home = mkdtempSync(join(tmpdir(), "lmsk-cli-"));
  const code = await main(args, {
    cwd: home,
    home,
    env: {},
    stdin: Readable.from([stdin]),
    stdout: { write: (text: string) => (out.stdout += text) },
    stderr: new Writable({
      write(chunk: Buffer, _encoding, done) {
        out.stderr += chunk.toString();
        done();
      },
    }),
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
      stdout: expect.stringContaining("lmsk install claude"),
      stderr: "",
    });
    expect(await run(["nope"])).toEqual({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("lmsk install claude"),
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

  it("stops serve with exit code 1 when the port of the proxy is in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", (error) =>
        isRecord(error) && error.code === "EADDRINUSE"
          ? resolve()
          : reject(error),
      );
      blocker.listen(SERVE_PORT, "127.0.0.1", resolve);
    });
    try {
      expect(await run(["serve"])).toEqual({
        code: 1,
        stdout: "",
        stderr: "lmsk: serve stopped: PORT_TAKEN.\n",
      });
    } finally {
      if (blocker.listening)
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
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

  it("refuses lmsk install claude without a terminal, with INSTALL_NOT_CONFIRMED", async () => {
    expect(await run(["install", "claude"])).toEqual({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(/^lmsk: INSTALL_NOT_CONFIRMED: /),
    });
  });
});

function terminal(isTTY: boolean) {
  return Object.assign(new PassThrough(), { isTTY });
}

describe("confirm", () => {
  it("answers yes when the input says y", async () => {
    const stdin = terminal(true);
    const stderr = terminal(true);
    const answer = confirm("Continue?", { stdin, stderr });

    stdin.write("y\n");

    expect(await answer).toBe(true);
  });

  it("answers no when the input ends during the question", async () => {
    const stdin = terminal(true);
    const stderr = terminal(true);
    const answer = confirm("Continue?", { stdin, stderr });

    stdin.end();

    expect(await answer).toBe(false);
  });

  it.each([
    ["the input", false, true],
    ["the output", true, false],
  ])(
    "answers no without a prompt when %s is not a terminal",
    async (_name, stdinIsTTY, stderrIsTTY) => {
      const stdin = terminal(stdinIsTTY);
      const stderr = terminal(stderrIsTTY);
      stdin.write("y\n");

      expect(await confirm("Continue?", { stdin, stderr })).toBe(false);
      expect(stderr.read()).toBeNull();
    },
  );
});
