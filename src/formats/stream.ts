import { isRecord } from "../core/index.ts";

/** One server-sent event. Its `data` is the joined data lines. */
export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** A tool call that a response stream carries, with its parsed arguments. */
export interface ToolInput {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** Returns the arguments that the agent gets for `call`. */
export type Restore = (call: ToolInput) => Record<string, unknown>;

/** Rewrites a provider response stream, one event at a time. */
export interface StreamCodec {
  /** Feeds one event and returns the events to send now. */
  push(event: SseEvent): SseEvent[];
}

/** The JSON object in `text`, or undefined when `text` is not a JSON object. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(value) ? value : undefined;
}

/** Replacements for the tool calls and tool results of a request, by call id. */
export interface TurnEdit {
  input(id: string, value: unknown): unknown;
  result(id: string, value: unknown): unknown;
}

/** Copies a request payload with each tool call input and tool result replaced through `edit`, in payload order. */
export type ToolTurns = (payload: unknown, edit: TurnEdit) => unknown;
