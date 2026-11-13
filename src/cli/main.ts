import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import {
  claudeHook,
  installClaude,
  SERVE_PORT,
  serveClaude,
} from "../claude-code/index.ts";
import { errorCode } from "../core/index.ts";

export interface Io {
  cwd: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(text: string): unknown };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

const USAGE = `Usage:
  lmsk install claude     Start the masking proxy at login and point Claude Code at it.
  lmsk serve              Run the masking proxy that Claude Code uses, until a signal ends it.
  lmsk hook claude        Run the PreToolUse hook on the hook input in stdin.
`;

/** Runs the command in `args` and returns the process exit code. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  const launch = {
    ...io,
    notify: (message: string) => io.stderr.write(`${message}\n`),
  };
  if (command === "install" && rest[0] === "claude")
    return installClaude({
      ...launch,
      platform: process.platform,
      node: process.execPath,
      bin: fileURLToPath(new URL("bin.js", import.meta.url)),
      run: (program, programArgs) =>
        spawnSync(program, programArgs, { stdio: "inherit" }).status ?? 1,
      confirm: (question) => confirm(question, io),
    });
  if (command === "serve") {
    await serveClaude({ ...launch, port: SERVE_PORT });
    return 0;
  }
  if (command === "hook" && rest[0] === "claude") return runHook(io);
  if (command === "--help" || command === "-h") {
    io.stdout.write(USAGE);
    return 0;
  }
  io.stderr.write(USAGE);
  return 1;
}

/** Asks on the terminal. Without a terminal for input and output, such as a tool call of an agent, the answer is no. */
export async function confirm(
  question: string,
  { stdin, stderr }: Pick<Io, "stdin" | "stderr">,
): Promise<boolean> {
  if (!stdin.isTTY || !stderr.isTTY) return false;
  const terminal = createInterface({ input: stdin, output: stderr });
  const closed = new AbortController();
  terminal.once("close", () => closed.abort());
  try {
    const answer = await terminal.question(`${question} [y/N] `, {
      signal: closed.signal,
    });
    return /^y(?:es)?$/i.test(answer.trim());
  } catch (error) {
    if (closed.signal.aborted) return false;
    throw error;
  } finally {
    terminal.close();
  }
}

/** Exit code 2 is the only failure that makes Claude Code block the call; any other lets the tool run. */
async function runHook(io: Io): Promise<number> {
  try {
    const output = claudeHook(JSON.parse(await text(io.stdin)), io);
    if (output !== undefined) io.stdout.write(output);
    return 0;
  } catch (error) {
    io.stderr.write(`lmsk: hook failed: ${errorCode(error)}.\n`);
    return 2;
  }
}
