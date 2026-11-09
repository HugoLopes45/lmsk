import { isRecord } from "@lmsk/core";
import type { ToolTurns, TurnEdit } from "./stream.ts";

function editBlock(block: unknown, edit: TurnEdit): unknown {
  if (!isRecord(block)) return block;
  if (block.type === "tool_use" && typeof block.id === "string")
    return { ...block, input: edit.input(block.id, block.input) };
  if (block.type === "tool_result" && typeof block.tool_use_id === "string")
    return {
      ...block,
      content: edit.result(block.tool_use_id, block.content),
    };
  return block;
}

function editMessage(message: unknown, edit: TurnEdit): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) => editBlock(block, edit)),
  };
}

/** The tool_use and tool_result blocks of an Anthropic Messages request. */
export const anthropicTurns: ToolTurns = (payload, edit) => {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  return {
    ...payload,
    messages: payload.messages.map((message) => editMessage(message, edit)),
  };
};
