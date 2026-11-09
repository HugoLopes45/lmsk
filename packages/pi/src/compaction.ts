import {
  compact,
  generateBranchSummary,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionBeforeTreeEvent,
  type SessionBeforeTreeResult,
} from "@earendil-works/pi-coding-agent";
import { isRecord, type Masker } from "@hugolopes45/lmsk-core";

type PayloadMasker = Pick<Masker, "maskPayload">;
type SummaryStream = NonNullable<Parameters<typeof compact>[7]>;

function maskedStream(
  ctx: ExtensionContext,
  masker: PayloadMasker,
): SummaryStream {
  return async (model, context, options) => {
    const stream = ctx.modelRegistry.streamSimple(model, context, {
      ...options,
      onPayload: async (payload) => {
        const masked = await masker.maskPayload(payload);
        options?.signal?.throwIfAborted();
        // Undefined means reuse the original payload in provider implementations.
        if (!isRecord(masked)) throw new Error("SUMMARY_PAYLOAD_SHAPE");
        return masked;
      },
    });
    const result = await stream.result();
    if (result.stopReason !== "stop") throw new Error("SUMMARY_INCOMPLETE");
    return stream;
  };
}

function cancel(ctx: ExtensionContext): { cancel: true } {
  try {
    ctx.ui.notify(
      "SUMMARY_BLOCKED: summary could not be safely generated",
      "error",
    );
  } catch {
    // A broken UI must not turn a cancellation into pi's default summary fallback.
    return { cancel: true };
  }
  return { cancel: true };
}

export async function compactMasked(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  masker: PayloadMasker,
): Promise<SessionBeforeCompactResult> {
  try {
    if (!ctx.model) return cancel(ctx);
    event.signal.throwIfAborted();
    const compaction = await compact(
      event.preparation,
      ctx.model,
      undefined,
      undefined,
      event.customInstructions,
      event.signal,
      ctx.thinkingLevel,
      maskedStream(ctx, masker),
    );
    event.signal.throwIfAborted();
    return { compaction };
  } catch {
    return cancel(ctx);
  }
}

export async function summarizeTreeMasked(
  event: SessionBeforeTreeEvent,
  ctx: ExtensionContext,
  masker: PayloadMasker,
): Promise<SessionBeforeTreeResult> {
  try {
    if (!event.preparation.userWantsSummary) return {};
    if (!ctx.model) return cancel(ctx);
    event.signal.throwIfAborted();
    const result = await generateBranchSummary(
      event.preparation.entriesToSummarize,
      {
        model: ctx.model,
        signal: event.signal,
        thinkingLevel: ctx.thinkingLevel,
        customInstructions: event.preparation.customInstructions,
        replaceInstructions: event.preparation.replaceInstructions,
        streamFn: maskedStream(ctx, masker),
      },
    );
    if (
      event.signal.aborted ||
      result.aborted ||
      result.error ||
      !result.summary?.trim()
    )
      return cancel(ctx);
    return {
      summary: {
        summary: result.summary,
        usage: result.usage,
        details: {
          readFiles: result.readFiles,
          modifiedFiles: result.modifiedFiles,
        },
      },
    };
  } catch {
    return cancel(ctx);
  }
}
