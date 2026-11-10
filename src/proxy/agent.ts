import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import type { HostContext } from "../core/index.ts";

export interface AgentOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  notify: HostContext["ui"]["notify"];
}

/** Runs the agent in this terminal until it ends, and returns its exit status as a shell gives it. */
export async function runAgent(
  command: string,
  args: readonly string[],
  { cwd, env, notify }: AgentOptions,
): Promise<number> {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...loopbackExempt(env) },
    stdio: "inherit",
  });
  // The terminal sends SIGINT to the agent too, and the agent decides whether it ends; the proxy must outlive it.
  const ignore = () => undefined;
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  // When lmsk ends on an error, another local user could listen on the freed port and get the agent's next request.
  const end = () => child.kill("SIGKILL");
  process.on("exit", end);
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  try {
    const [code, signal] = await once(child, "exit");
    return typeof code === "number" ? code : 128 + signalNumber(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    notify(`lmsk: ${command} is not on your PATH.`, "error");
    return 127;
  } finally {
    process.off("exit", end);
    process.off("SIGINT", ignore);
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
  }
}

/** Claude Code sends even a 127.0.0.1 base URL through `HTTP_PROXY`, so that proxy would see the unmasked request. */
export function loopbackExempt(
  env: AgentOptions["env"],
): Record<"NO_PROXY" | "no_proxy", string> {
  // A tool that reads the spelling the user did not set must still get the user's exemptions.
  const exempt = (own: string | undefined, other: string | undefined) => {
    const list = own || other;
    return list ? `${list},127.0.0.1` : "127.0.0.1";
  };
  return {
    NO_PROXY: exempt(env.NO_PROXY, env.no_proxy),
    no_proxy: exempt(env.no_proxy, env.NO_PROXY),
  };
}

/** The shell's exit status of a process that a signal ended is 128 plus the signal number. */
function signalNumber(signal: unknown): number {
  const names: Readonly<Record<string, number>> = constants.signals;
  return typeof signal === "string" ? (names[signal] ?? 0) : 0;
}
