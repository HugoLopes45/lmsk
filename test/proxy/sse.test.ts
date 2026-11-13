import { setTimeout as delay } from "node:timers/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readEvents, writeEvent } from "../../src/proxy/sse.ts";

async function* bytes(chunks: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
}

async function events(chunks: string[]) {
  const read = [];
  for await (const event of readEvents(bytes(chunks))) read.push(event);
  return read;
}

describe("SSE", () => {
  it("reads events split across chunks, with CRLF, comments and multi-line data", async () => {
    expect(
      await events([
        ": keep-alive\r\nevent: a\r\nda",
        'ta: {"x":1}\r\n\r\ndata: one\ndata:two\n\nevent: empty\n\n',
        "data: cut",
      ]),
    ).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: undefined, data: "one\ntwo" },
    ]);
  });

  it("reads a character whose bytes are split across chunks", async () => {
    const body = new TextEncoder().encode("data: é\n\n");
    async function* split(): AsyncGenerator<Uint8Array> {
      yield body.subarray(0, 7);
      yield body.subarray(7);
    }
    const read = [];
    for await (const event of readEvents(split())) read.push(event);

    expect(read).toEqual([{ event: undefined, data: "é" }]);
  });

  it("reads the same events for every split of the body bytes", async () => {
    const line = fc
      .string({ unit: "grapheme" })
      .filter((text) => !/[\r\n]/.test(text));
    const event = fc.record({
      event: fc.option(line, { nil: undefined }),
      lines: fc.array(line, { minLength: 1, maxLength: 3 }),
      end: fc.constantFrom("\n", "\r\n", "\r"),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(event, { maxLength: 5 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        async (written, cuts) => {
          const body = new TextEncoder().encode(
            written
              .map(({ event: name, lines, end }) =>
                [
                  ...(name === undefined ? [] : [`event: ${name}`]),
                  ...lines.map((value) => `data: ${value}`),
                  "",
                  "",
                ].join(end),
              )
              .join(""),
          );
          const offsets = [
            ...new Set(cuts.map((cut) => cut % (body.length + 1))),
          ].sort((a, b) => a - b);
          async function* split(): AsyncGenerator<Uint8Array> {
            let from = 0;
            for (const offset of [...offsets, body.length]) {
              yield body.subarray(from, offset);
              from = offset;
            }
          }
          const read = [];
          for await (const item of readEvents(split())) read.push(item);
          expect(read).toEqual(
            written.map(({ event: name, lines }) => ({
              event: name,
              data: lines.join("\n"),
            })),
          );
        },
      ),
    );
  });

  it("ends a line at a lone CR, so an event name cannot hide another event", async () => {
    expect(
      await events([
        'event: ping\r\revent: content_block_start\rdata: {"a":1}\r\r',
      ]),
    ).toEqual([{ event: "content_block_start", data: '{"a":1}' }]);
  });

  it.each([
    ["CR", ["data: a\r\r", "\ndata: b\r\r"]],
    ["CRLF split across chunks", ["data: a\r\n\r", "\ndata: b\r\n\r\n"]],
  ])(
    "gives an event when its blank line arrives, before the next chunk, with %s",
    async (_name, [first, second]) => {
      let release = () => {};
      const sent = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* body(): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode(first);
        await sent;
        yield new TextEncoder().encode(second);
      }
      const read = readEvents(body());

      const early = await Promise.race([read.next(), delay(100, "waiting")]);
      release();

      expect(early).toEqual({
        done: false,
        value: { event: undefined, data: "a" },
      });
      expect(await read.next()).toEqual({
        done: false,
        value: { event: undefined, data: "b" },
      });
      expect(await read.next()).toEqual({ done: true, value: undefined });
    },
  );

  it.each([
    [["data: a\r", "\ndata: b\r\n\r\n"]],
    [["data: a\r", "", "\ndata: b\r\n\r\n"]],
  ])("reads a CRLF split across chunks as one line end: %j", async (chunks) => {
    expect(await events(chunks)).toEqual([{ event: undefined, data: "a\nb" }]);
  });

  it("writes an event that reads back the same", async () => {
    const event = { event: "e", data: "one\ntwo" };
    expect(await events([writeEvent(event)])).toEqual([event]);
    expect(writeEvent({ event: undefined, data: "x" })).toBe("data: x\n\n");
  });
});
