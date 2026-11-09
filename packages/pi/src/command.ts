import {
  errorCode,
  type Guard,
  type HostContext,
  type Redaction,
} from "@lmsk/core";
import { NAME } from "./profile.ts";

export const COMMAND = NAME;

/**
 * Runs `/lmsk status|on|off|reveal [text]`. Without text, `reveal` takes `lastReply`.
 * Its notices show real values on screen only: a command and its notice never reach the provider.
 */
export function runCommand(
  guard: Guard,
  args: string,
  ctx: HostContext,
  lastReply: () => string | undefined,
): void {
  const reveals = /^\s*reveal\s+(\S[\s\S]*)$/.exec(args);
  if (reveals) {
    reveal(guard, reveals[1], ctx);
    return;
  }
  switch (args.trim()) {
    case "reveal": {
      const reply = lastReply();
      if (reply === undefined)
        ctx.ui.notify(
          `${NAME}: no assistant message on this branch to reveal.`,
          "error",
        );
      else reveal(guard, reply, ctx);
      return;
    }
    case "status":
      ctx.ui.notify(guard.status(), "info");
      return;
    case "on":
      setRedaction(guard, "enabled", ctx);
      return;
    case "off":
      setRedaction(guard, "off", ctx);
      return;
    default:
      ctx.ui.notify(`Usage: /${COMMAND} status|on|off|reveal [text]`, "error");
  }
}

function setRedaction(guard: Guard, next: Redaction, ctx: HostContext): void {
  let notice: string;
  try {
    notice = guard.setRedaction(next);
  } catch (error) {
    ctx.ui.notify(
      `${NAME}: blocked (${errorCode(error)}). /${COMMAND} cannot change masking until the session reloads.`,
      "error",
    );
    return;
  }
  ctx.ui.notify(notice, next === "off" ? "warning" : "info");
}

function reveal(guard: Guard, text: string, ctx: HostContext): void {
  let restored: string;
  try {
    restored = guard.restoreText(text);
  } catch (error) {
    ctx.ui.notify(
      `${NAME}: blocked (${errorCode(error)}). /${COMMAND} reveal needs a working vault.`,
      "error",
    );
    return;
  }
  ctx.ui.notify(restored, "info");
}
