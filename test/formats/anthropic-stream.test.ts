import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TextRestorer } from "../../src/core/restorer.ts";
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

/** Shows each `FAKE` as `REAL`. */
const fakes = {
  shownSpans: (text: string, from: number): [number, number, string][] =>
    [...text.matchAll(/FAKE/g)]
      .filter((match) => match.index >= from)
      .map((match) => [match.index, match.index + 4, "REAL"]),
  longestFake: () => 4,
};

function run(
  events: SseEvent[],
  restore: (call: ToolInput) => Record<string, unknown>,
): SseEvent[] {
  const codec = anthropicStream(restore, () => new TextRestorer(fakes));
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

  it("restores the same input for every split of the argument JSON into deltas", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.string({ unit: "grapheme" })),
        fc.array(fc.nat(), { maxLength: 8 }),
        (input, cuts) => {
          const json = JSON.stringify(input);
          const offsets = [
            ...new Set(cuts.map((cut) => cut % (json.length + 1))),
          ].sort((a, b) => a - b);
          const parts = [...offsets, json.length].map((offset, at, all) =>
            json.slice(at === 0 ? 0 : all[at - 1], offset),
          );
          const restored = Object.fromEntries(
            Object.entries(input).map(([key, value]) => [
              key,
              value.toUpperCase(),
            ]),
          );

          expect(
            run(
              [start(1), ...parts.map((part) => jsonDelta(1, part)), stop(1)],
              upper,
            ),
          ).toEqual([
            start(1),
            jsonDelta(1, JSON.stringify(restored)),
            stop(1),
          ]);
        },
      ),
    );
  });

  it("passes thinking and other events unchanged and in order", async () => {
    const events = [
      sse({ type: "message_start", message: { id: "msg_1" } }),
      start(0, "thinking"),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "a FAKE" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "FAKE" },
      }),
      stop(0),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      sse({ type: "message_stop" }),
    ];

    expect(run(events, upper)).toEqual(events);
  });

  it("restores a text block for the agent, also a fake split across deltas, and gives the rest at the block end", async () => {
    const out = run(
      [
        start(0, "text"),
        textDelta(0, "a FA"),
        textDelta(0, "KE b FAKE"),
        stop(0),
      ],
      upper,
    );

    expect(out[0]).toEqual(start(0, "text"));
    expect(out.at(-1)).toEqual(stop(0));
    const texts = out.slice(1, -1).map((event) => JSON.parse(event.data));
    expect(texts.every((data) => data.delta.type === "text_delta")).toBe(true);
    expect(texts.map((data) => data.delta.text).join("")).toBe("a REAL b REAL");
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

  it("stops the stream when an event name differs from its data type", () => {
    const hidden = {
      event: "ping",
      data: JSON.stringify({
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "toolu_02",
          name: "Read",
          input: {},
        },
      }),
    };

    expect(() =>
      run(
        [start(1), hidden, jsonDelta(1, '{"command":"echo FAKE"}'), stop(1)],
        upper,
      ),
    ).toThrow("an event name is not its data type");
  });

  it("stops the stream when an event with JSON data has no name", () => {
    const unnamed = { event: undefined, data: start(1).data };

    expect(() => run([unnamed], upper)).toThrow(
      "an event name is not its data type",
    );
  });

  it("stops the stream when a block index is not a whole number", () => {
    const named = sse({
      type: "content_block_delta",
      index: "1",
      delta: { type: "input_json_delta", partial_json: '{"command":"FAKE"}' },
    });

    expect(() => run([start(1), named, stop(1)], upper)).toThrow(
      "STREAM_INVALID",
    );
  });

  it("passes an event of an unknown type unchanged, also with an index that is not a number", () => {
    const unknown = sse({ type: "content_block_future", index: "1" });

    expect(run([unknown], upper)).toEqual([unknown]);
  });

  it("stops the stream when a block starts over an open thinking block", () => {
    const thinking = sse({
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "" },
    });

    expect(() => run([thinking, start(1)], upper)).toThrow(
      "a block starts at an open index",
    );
  });

  it("accepts a block at the index of a block that stopped", () => {
    const out = run(
      [start(1), stop(1), start(1, "text"), textDelta(1, "a FAKE"), stop(1)],
      upper,
    );

    expect(JSON.stringify(out)).toContain("REAL");
  });

  it("stops the stream when a block starts at an index that is still open", () => {
    expect(() => run([start(1), start(1, "text")], upper)).toThrow(
      "a block starts at an open index",
    );
  });

  it("keeps the fakes of a text block that starts with a signature", () => {
    const signed = sse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", signature: "sig" },
    });

    const out = run([signed, textDelta(0, "a FAKE"), stop(0)], upper);

    expect(JSON.stringify(out)).toContain("FAKE");
    expect(JSON.stringify(out)).not.toContain("REAL");
  });

  it("drops a signature delta on a text block that it restores", () => {
    const signature = sse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig" },
    });

    const out = run(
      [start(0, "text"), textDelta(0, "a FAKE"), signature, stop(0)],
      upper,
    );

    expect(JSON.stringify(out)).toContain("REAL");
    expect(JSON.stringify(out)).not.toContain("signature_delta");
  });

  it("passes an event whose data is not JSON unchanged", async () => {
    const event = { event: "error", data: "upstream overloaded" };

    expect(run([event], upper)).toEqual([event]);
  });
});
