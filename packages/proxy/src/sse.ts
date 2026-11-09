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

/** The events of an SSE body. An event that the body does not end with a blank line is dropped. */
export async function* readEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const lines = new EventLines();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const complete = buffer.split("\n");
    buffer = complete.pop() ?? "";
    for (const line of complete) {
      const event = lines.line(line.replace(/\r$/, ""));
      if (event !== undefined) yield event;
    }
  }
}

export function writeEvent({ event, data }: SseEvent): string {
  const name = event === undefined ? "" : `event: ${event}\n`;
  const lines = data
    .split("\n")
    .map((line) => `data: ${line}\n`)
    .join("");
  return `${name}${lines}\n`;
}
