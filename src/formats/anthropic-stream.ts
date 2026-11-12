import { isRecord, type TextRestorer } from "../core/index.ts";
import {
  parseObject,
  type Restore,
  type SseEvent,
  type StreamCodec,
} from "./stream.ts";

/** A tool_use block whose argument deltas are held until the block ends. */
interface HeldCall {
  id: string;
  tool: string;
  deltas: SseEvent[];
  json: string;
}

function toolUseStart(block: Record<string, unknown>): HeldCall | undefined {
  if (block.type !== "tool_use") return undefined;
  if (typeof block.id !== "string" || typeof block.name !== "string")
    return undefined;
  return { id: block.id, tool: block.name, deltas: [], json: "" };
}

/** The string field `key` of a delta of type `type`. */
function deltaField(
  data: Record<string, unknown>,
  type: string,
  key: string,
): string | undefined {
  const delta = data.delta;
  if (!isRecord(delta) || delta.type !== type) return undefined;
  const value = delta[key];
  return typeof value === "string" ? value : undefined;
}

function delta(index: unknown, delta: Record<string, string>): SseEvent {
  const data = { type: "content_block_delta", index, delta };
  return { event: "content_block_delta", data: JSON.stringify(data) };
}

/**
 * The Anthropic Messages stream. The arguments of a tool_use block reach the agent as one
 * `input_json_delta` with the restored input, sent at `content_block_stop`. Arguments that are
 * not a JSON object pass unchanged, so their fakes stay. A text block reaches the agent restored;
 * thinking stays as sent, because its signature covers it.
 */
export function anthropicStream(
  restore: Restore,
  textRestorer: () => TextRestorer,
): StreamCodec {
  const calls = new Map<unknown, HeldCall>();
  const texts = new Map<unknown, TextRestorer>();

  const shown = (index: unknown, text: string): SseEvent[] =>
    text === "" ? [] : [delta(index, { type: "text_delta", text })];

  const start = (data: Record<string, unknown>): void => {
    const block = data.content_block;
    if (!isRecord(block)) return;
    if (block.type === "text") texts.set(data.index, textRestorer());
    const call = toolUseStart(block);
    if (call !== undefined) calls.set(data.index, call);
  };

  const piece = (event: SseEvent, data: Record<string, unknown>) => {
    const call = calls.get(data.index);
    const partial = deltaField(data, "input_json_delta", "partial_json");
    if (call !== undefined && partial !== undefined) {
      call.deltas.push(event);
      call.json += partial;
      return [];
    }
    const text = texts.get(data.index);
    const added = deltaField(data, "text_delta", "text");
    if (text !== undefined && added !== undefined)
      return shown(data.index, text.push(added));
    return [event];
  };

  const release = (call: HeldCall, index: unknown): SseEvent[] => {
    const input = parseObject(call.json);
    if (input === undefined) return call.deltas;
    const restored = restore({ id: call.id, tool: call.tool, input });
    return [
      delta(index, {
        type: "input_json_delta",
        partial_json: JSON.stringify(restored),
      }),
    ];
  };

  const stop = (index: unknown): SseEvent[] => {
    const call = calls.get(index);
    const text = texts.get(index);
    calls.delete(index);
    texts.delete(index);
    if (call !== undefined) return release(call, index);
    return text === undefined ? [] : shown(index, text.end());
  };

  return {
    push(event) {
      const data = parseObject(event.data);
      if (data?.type === "content_block_start") start(data);
      if (data?.type === "content_block_delta") return piece(event, data);
      if (data?.type === "content_block_stop")
        return [...stop(data.index), event];
      return [event];
    },
  };
}
