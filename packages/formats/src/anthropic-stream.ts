import { isRecord } from "@hugolopes45/lmsk-core";
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

function toolUseStart(data: Record<string, unknown>): HeldCall | undefined {
  const block = data.content_block;
  if (!isRecord(block) || block.type !== "tool_use") return undefined;
  if (typeof block.id !== "string" || typeof block.name !== "string")
    return undefined;
  return { id: block.id, tool: block.name, deltas: [], json: "" };
}

function partialJson(data: Record<string, unknown>): string | undefined {
  const delta = data.delta;
  return isRecord(delta) &&
    delta.type === "input_json_delta" &&
    typeof delta.partial_json === "string"
    ? delta.partial_json
    : undefined;
}

/**
 * The Anthropic Messages stream: the arguments of a tool_use block reach the agent as one
 * `input_json_delta` with the restored input, sent at `content_block_stop`. Arguments that are
 * not a JSON object pass unchanged, so their fakes stay.
 */
export function anthropicStream(restore: Restore): StreamCodec {
  const held = new Map<unknown, HeldCall>();

  const release = (call: HeldCall, index: unknown): SseEvent[] => {
    held.delete(index);
    const input = parseObject(call.json);
    if (input === undefined) return call.deltas;
    const restored = restore({ id: call.id, tool: call.tool, input });
    const data = {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(restored),
      },
    };
    return [{ event: "content_block_delta", data: JSON.stringify(data) }];
  };

  return {
    push(event) {
      const data = parseObject(event.data);
      if (data === undefined) return [event];
      const call = held.get(data.index);
      if (data.type === "content_block_start") {
        const started = toolUseStart(data);
        if (started !== undefined) held.set(data.index, started);
        return [event];
      }
      const partial = partialJson(data);
      if (call !== undefined && partial !== undefined) {
        call.deltas.push(event);
        call.json += partial;
        return [];
      }
      if (call !== undefined && data.type === "content_block_stop")
        return [...release(call, data.index), event];
      return [event];
    },
  };
}
