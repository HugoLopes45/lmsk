/** One server-sent event. Its `data` is the joined data lines. */
export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** Collects the fields of one event until the blank line that ends it. Comments, `id` and `retry` are dropped. */
class EventLines {
  private event: string | undefined;
  private data: string[] = [];

  /** Takes one line without its end of line; returns the event that a blank line ends. */
  line(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "event") this.event = value;
    else if (name === "data") this.data.push(value);
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const event =
      this.data.length === 0
        ? undefined
        : { event: this.event, data: this.data.join("\n") };
    this.event = undefined;
    this.data = [];
    return event;
  }
}

/** The lines that `buffer` ends, and the rest. CR, LF and CRLF end a line; a CR at the end waits, as it may start a CRLF. */
function splitLines(buffer: string): { complete: string[]; rest: string } {
  const held = buffer.endsWith("\r") ? "\r" : "";
  const complete = buffer
    .slice(0, buffer.length - held.length)
    .split(/\r\n|\r|\n/);
  return { complete, rest: (complete.pop() ?? "") + held };
}

/** The events of an SSE body. An event that the body does not end with a blank line is dropped. */
export async function* readEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const lines = new EventLines();
  let buffer = "";
  for await (const chunk of chunks) {
    const { complete, rest } = splitLines(
      buffer + decoder.decode(chunk, { stream: true }),
    );
    buffer = rest;
    for (const line of complete) {
      const event = lines.line(line);
      if (event !== undefined) yield event;
    }
  }
  const last = buffer.endsWith("\r")
    ? lines.line(buffer.slice(0, -1))
    : undefined;
  if (last !== undefined) yield last;
}

export function writeEvent({ event, data }: SseEvent): string {
  const name = event === undefined ? "" : `event: ${event}\n`;
  const lines = data
    .split("\n")
    .map((line) => `data: ${line}\n`)
    .join("");
  return `${name}${lines}\n`;
}
