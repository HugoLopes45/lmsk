import { join } from "node:path";
import {
  type ExtensionFactory,
  getAgentDir,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  assertPayloadSize,
  Guard,
  type HostContext,
  localIdentityRules,
  type ReferenceRecords,
} from "@lmsk/core";
import { COMMAND, runCommand } from "../src/command.ts";
import { compactMasked, summarizeTreeMasked } from "../src/compaction.ts";
import { installModelGuard } from "../src/guard-runtime.ts";
import type { BranchRecord, HookApi, HookContext } from "../src/host.ts";
import {
  isMaskedMessage,
  mapToolResultText,
  maskMessage,
  maskTexts,
  withheldMessage,
  withheldResultFields,
} from "../src/messages.ts";
import {
  GLOBAL_CONFIG,
  NAME,
  PI_DEFAULTS,
  PROJECT_CONFIG,
  VAULT_ENTRY,
  VAULT_STORE_DIR,
} from "../src/profile.ts";
import { commandKeyOf, isBuiltinTool, pathOf } from "../src/tools.ts";

/** The vault references on the branch, in branch order. */
function referencesOf(branch: readonly BranchRecord[]): unknown[] {
  return branch.flatMap((entry) =>
    entry.type === "custom" && entry.customType === VAULT_ENTRY
      ? [entry.data]
      : [],
  );
}

/** The text of the last assistant message on the branch. */
function lastReply(ctx: HookContext): string | undefined {
  const message = ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.message?.role === "assistant")?.message;
  if (message?.role !== "assistant") return undefined;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function lmsk(pi: HookApi): void {
  const guard = new Guard({
    ...PI_DEFAULTS,
    name: NAME,
  });

  /** A session replacement fires session_start again, so this session manager serves the whole session. */
  const branchReferences = (
    sessionManager: HookContext["sessionManager"],
  ): ReferenceRecords => ({
    read: () => referencesOf(sessionManager.getBranch()),
    append: (reference) => pi.appendEntry(VAULT_ENTRY, reference),
  });

  // The glued text stays in the history and blocks each later request, so each block shows the way out.
  const reportBlock = (ctx: HostContext, code: string): void => {
    if (code === "HIDDEN_REAL")
      ctx.ui.notify(
        `${NAME}: HIDDEN_REAL. A secret glued to a word is in the conversation or a context file. Use /tree to go back before it without a summary, start a new session, or remove it from the context file.`,
        "error",
      );
    else guard.report(ctx, code);
  };

  const blockRequest = (
    ctx: HostContext,
    code: string,
  ): Record<string, never> => {
    guard.failClosed(ctx, code, reportBlock);
    return {};
  };

  const withheldResult = (
    ctx: HostContext,
    code: string,
  ): ToolResultEventResult => {
    guard.failClosed(ctx, code);
    return withheldResultFields();
  };

  pi.registerCommand(COMMAND, {
    description:
      "Show masking status, turn masking off or on, or reveal the real values of fakes on screen",
    handler: async (args, ctx) => {
      runCommand(guard, args, ctx, () => lastReply(ctx));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    installModelGuard(ctx.modelRegistry, guard.maskText);
    guard.open(() => {
      const agentDir = getAgentDir();
      return {
        configPaths: [join(agentDir, GLOBAL_CONFIG)],
        projectConfigPath: ctx.isProjectTrusted()
          ? join(ctx.cwd, PROJECT_CONFIG)
          : undefined,
        storeDir: join(agentDir, VAULT_STORE_DIR),
        references: branchReferences(ctx.sessionManager),
        env: process.env,
        defaultRules: localIdentityRules(),
      };
    }, ctx);
  });

  // Navigation moves the leaf without a new session, so the new branch needs its own reference.
  pi.on("session_tree", (_event, ctx) => {
    guard.attachReferences(ctx);
  });

  pi.on("session_shutdown", () => {
    guard.close();
  });

  // A call that ends without a result, such as a blocked one, skips tool_result.
  pi.on("tool_execution_end", (event) => {
    guard.toolEnd(event.toolCallId);
  });

  pi.on("before_provider_request", (event, ctx) =>
    guard.guarded(ctx, blockRequest, async () =>
      guard.off ? undefined : guard.maskPayload(event.payload),
    ),
  );

  pi.on("tool_call", (event, ctx) => {
    const { blocked } = guard.toolCall({
      id: event.toolCallId,
      tool: event.toolName,
      input: event.input,
      verified: isBuiltinTool(pi, event.toolName),
      commandKey: commandKeyOf(event),
      cwd: ctx.cwd,
      path: () => pathOf(event),
    });
    if (blocked) return { block: true, reason: "protected path" };
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (!isMaskedMessage(message) || guard.off) return;
    // Before any await: if this handler fails, pi persists the neutral form, not the raw text.
    const original = { ...message };
    const withheld = withheldMessage(message);
    Object.assign(message, withheld);
    return guard.guarded(
      ctx,
      (failed, code) => {
        guard.failClosed(failed, code);
        return { message: withheld };
      },
      async () => ({
        message: await maskMessage((texts) => guard.maskTexts(texts), original),
      }),
    );
  });

  pi.on("tool_result", async (event, ctx) => {
    // Before any await: a throw below keeps the fields already set on the event.
    const maskResult = guard.toolResult(event.toolCallId);
    if (guard.off) return undefined;
    const original = {
      content: event.content,
      structuredContent: event.structuredContent,
      details: event.details,
    };
    Object.assign(event, withheldResultFields());
    return guard.guarded(
      ctx,
      withheldResult,
      async (): Promise<ToolResultEventResult> => {
        assertPayloadSize(original.details);
        return maskTexts(maskResult, original, mapToolResultText);
      },
    );
  });

  /** Cancels pi's summary, which pi would otherwise build from raw text. */
  const cancel = (ctx: HostContext, code: string): { cancel: true } => {
    try {
      guard.report(ctx, code);
    } catch {
      // A broken UI must not turn a cancellation into pi's default summary fallback.
    }
    return { cancel: true };
  };

  pi.on("session_before_compact", (event, ctx) =>
    guard.guarded(ctx, cancel, () =>
      compactMasked(event, ctx, guard.payloadMasker()),
    ),
  );

  pi.on("session_before_tree", (event, ctx) =>
    guard.guarded(ctx, cancel, () =>
      summarizeTreeMasked(event, ctx, guard.payloadMasker()),
    ),
  );
}

export default lmsk satisfies ExtensionFactory;
