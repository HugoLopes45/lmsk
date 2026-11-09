import { text } from "node:stream/consumers";
import { claudeHook, launchClaude } from "../claude-code/index.ts";
import { errorCode } from "../core/index.ts";

export interface Io {
  cwd: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<string | Buffer>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const USAGE = `Usage:
  lmsk claude [args...]   Run Claude Code behind the masking proxy.
  lmsk hook claude        Run the PreToolUse hook on the hook input in stdin.
`;

/** Runs the command in `args` and returns the process exit code. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  const launch = {
    ...io,
    notify: (message: string) => io.stderr.write(`${message}\n`),
  };
  if (command === "claude") return launchClaude(rest, launch);
  if (command === "hook" && rest[0] === "claude") return runHook(io);
  if (command === "--help" || command === "-h") {
    io.stdout.write(USAGE);
    return 0;
  }
  io.stderr.write(USAGE);
  return 1;
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
