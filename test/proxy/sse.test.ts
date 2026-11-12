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
      end: fc.constantFrom("\n", "\r\n"),
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

  it("writes an event that reads back the same", async () => {
    const event = { event: "e", data: "one\ntwo" };
    expect(await events([writeEvent(event)])).toEqual([event]);
    expect(writeEvent({ event: undefined, data: "x" })).toBe("data: x\n\n");
  });
});
