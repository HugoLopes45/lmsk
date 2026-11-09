import { describe, expect, it } from "vitest";
import {
  anthropicStream,
  type SseEvent,
  type ToolInput,
} from "../../src/formats/index.ts";

function sse(data: Record<string, unknown>): SseEvent {
  return { event: String(data.type), data: JSON.stringify(data) };
}

const start = (index: number, type = "tool_use") =>
  sse({
    type: "content_block_start",
    index,
    content_block:
      type === "tool_use"
        ? { type, id: `toolu_0${index}`, name: "Bash", input: {} }
        : { type, text: "" },
  });
const jsonDelta = (index: number, partial: string) =>
  sse({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partial },
  });
const textDelta = (index: number, text: string) =>
  sse({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
const stop = (index: number) => sse({ type: "content_block_stop", index });
const ping = sse({ type: "ping" });

function run(
  events: SseEvent[],
  restore: (call: ToolInput) => Record<string, unknown>,
): SseEvent[] {
  const codec = anthropicStream(restore);
  return events.flatMap((event) => codec.push(event));
}

const upper = (call: ToolInput) =>
  Object.fromEntries(
    Object.entries(call.input).map(([key, value]) => [
      key,
      typeof value === "string" ? value.toUpperCase() : value,
    ]),
  );

describe("anthropicStream", () => {
  it("holds a tool call's argument deltas and emits the restored input once, at the block end", async () => {
    const calls: ToolInput[] = [];
    const out = run(
      [
        start(1),
        jsonDelta(1, ""),
        jsonDelta(1, '{"command": "echo '),
        ping,
        jsonDelta(1, 'fake"}'),
        stop(1),
      ],
      (call) => {
        calls.push(structuredClone(call));
        return upper(call);
      },
    );

    expect(calls).toEqual([
      { id: "toolu_01", tool: "Bash", input: { command: "echo fake" } },
    ]);
    expect(out).toEqual([
      start(1),
      ping,
      jsonDelta(1, '{"command":"ECHO FAKE"}'),
      stop(1),
    ]);
  });

  it("passes text, thinking and other events unchanged and in order", async () => {
    const events = [
      sse({ type: "message_start", message: { id: "msg_1" } }),
      start(0, "text"),
      textDelta(0, "fake value"),
      stop(0),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      sse({ type: "message_stop" }),
    ];

    expect(run(events, upper)).toEqual(events);
  });

  it("keeps parallel tool calls apart by block index", async () => {
    const out = run(
      [
        start(1),
        start(2),
        jsonDelta(2, '{"a":"two"}'),
        jsonDelta(1, '{"a":"one"}'),
        stop(2),
        stop(1),
      ],
      upper,
    );

    expect(out).toEqual([
      start(1),
      start(2),
      jsonDelta(2, '{"a":"TWO"}'),
      stop(2),
      jsonDelta(1, '{"a":"ONE"}'),
      stop(1),
    ]);
  });

  it.each([
    ["arguments that are not JSON", ['{"command": "echo', " fake"]],
    ["arguments that are not an object", ['["echo"]']],
    ["empty arguments", [""]],
  ])("emits %s unchanged, without a restore", async (_name, parts) => {
    const deltas = parts.map((part) => jsonDelta(1, part));
    const restore = () => {
      throw new Error("no restore expected");
    };

    expect(run([start(1), ...deltas, stop(1)], restore)).toEqual([
      start(1),
      ...deltas,
      stop(1),
    ]);
  });

  it("passes an event whose data is not JSON unchanged", async () => {
    const event = { event: "error", data: "upstream overloaded" };

    expect(run([event], upper)).toEqual([event]);
  });
});
