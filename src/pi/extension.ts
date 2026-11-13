import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ExtensionFactory,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  Guard,
  type HostContext,
  localIdentityRules,
  machinePaths,
  type ToolCall,
} from "../core/index.ts";
import { COMMAND, runCommand } from "./command.ts";
import { compactMasked, summarizeTreeMasked } from "./compaction.ts";
import { installModelGuard } from "./guard-runtime.ts";
import type { BranchRecord, HookApi, HookContext } from "./host.ts";
import { GLOBAL_CONFIG, NAME, PI_DEFAULTS, PROJECT_CONFIG } from "./profile.ts";
import { commandKeyOf, isBuiltinTool, targetsOf } from "./tools.ts";

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

/** The ids of the tool calls on the branch. A provider payload can change them or leave them out. */
function callIdsOf(branch: readonly BranchRecord[]): string[] {
  return branch.flatMap(({ message }) =>
    message?.role === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.id] : [],
        )
      : [],
  );
}

/**
 * Masks on the wire only: pi, its session and its tools keep real values. Each provider request is
 * masked whole, and each tool call gets its input restored.
 */
function lmsk(pi: HookApi): void {
  const paths = machinePaths(process.env, homedir());
  const guard = new Guard({
    ...PI_DEFAULTS,
    protectedPaths: [...PI_DEFAULTS.protectedPaths, ...paths.protectedPaths],
    name: NAME,
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

  pi.registerCommand(COMMAND, {
    description:
      "Show masking status, turn masking off or on, or reveal the real values of fakes on screen",
    handler: async (args, ctx) => {
      runCommand(guard, args, ctx, () => lastReply(ctx));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    installModelGuard(ctx.modelRegistry, guard.maskText, (payload) =>
      guard.maskPayload(payload, callIdsOf(ctx.sessionManager.getBranch())),
    );
    guard.open(
      () => ({
        configPaths: [join(getAgentDir(), GLOBAL_CONFIG)],
        projectConfigPath: ctx.isProjectTrusted()
          ? join(ctx.cwd, PROJECT_CONFIG)
          : undefined,
        stateDir: paths.stateDir,
        env: process.env,
        defaultRules: localIdentityRules(),
      }),
      ctx,
    );
  });

  pi.on("session_shutdown", () => {
    guard.close();
  });

  pi.on("before_provider_request", (event, ctx) =>
    guard.guarded(ctx, blockRequest, async () =>
      guard.off
        ? undefined
        : guard.maskPayload(
            event.payload,
            callIdsOf(ctx.sessionManager.getBranch()),
          ),
    ),
  );

  const callOf = (
    id: string,
    tool: string,
    input: Record<string, unknown>,
    cwd: string,
  ): ToolCall => ({
    id,
    tool,
    input,
    verified: isBuiltinTool(pi, tool),
    commandKey: commandKeyOf(tool),
    cwd,
    targets: (args) => targetsOf(tool, args),
  });

  pi.on("tool_call", (event, ctx) => {
    // Pi names a nested call `<caller id>/<n>`. Only the id of the call that the model made reaches the provider.
    const id =
      event.parentToolCallId === undefined
        ? event.toolCallId
        : event.toolCallId.replace(/(?:\/\d+)+$/, "");
    const call = callOf(id, event.toolName, event.input, ctx.cwd);
    if (guard.restoreCall(call).blocked)
      return { block: true, reason: "protected path" };
  });

  /** Thinking keeps its fakes: a provider can sign it, and the wire sends a signed text as written. */
  const restoredPart = (
    part: AssistantMessage["content"][number],
    cwd: string,
  ): AssistantMessage["content"][number] => {
    if (part.type === "text") {
      const restorer = guard.textRestorer();
      return { ...part, text: restorer.push(part.text) + restorer.end() };
    }
    if (part.type !== "toolCall") return part;
    const input = structuredClone(part.arguments);
    return guard.restoreCall(callOf(part.id, part.name, input, cwd)).blocked
      ? part
      : { ...part, arguments: input };
  };

  // Pi saves and shows the message that this handler returns, and then runs its tool calls.
  pi.on("message_end", (event, ctx) => {
    const { message } = event;
    if (message.role !== "assistant") return;
    return {
      message: {
        ...message,
        content: message.content.map((part) => restoredPart(part, ctx.cwd)),
      },
    };
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

  const summaryMasker = (ctx: HookContext) =>
    guard.payloadMasker(callIdsOf(ctx.sessionManager.getBranch()));

  pi.on("session_before_compact", (event, ctx) =>
    guard.guarded(ctx, cancel, () =>
      compactMasked(event, ctx, summaryMasker(ctx)),
    ),
  );

  pi.on("session_before_tree", (event, ctx) =>
    guard.guarded(ctx, cancel, () =>
      summarizeTreeMasked(event, ctx, summaryMasker(ctx)),
    ),
  );
}

export default lmsk satisfies ExtensionFactory;
