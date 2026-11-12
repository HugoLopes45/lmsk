/** The fakes that the user sees as reals. */
export interface ShownFakes {
  /** Start, end and text to show of each fake in `text` from `from` on. */
  shownSpans(
    text: string,
    from: number,
  ): [start: number, end: number, shown: string][];
  longestFake(): number;
}

/**
 * Restores text that arrives in pieces, such as a response stream. The output does not depend on
 * where the pieces are cut: the text in which a fake can still start is held back.
 */
export class TextRestorer {
  private readonly fakes: ShownFakes;
  /** The text not given back yet, after the character before it: a fake does not start inside a word. */
  private pending = "";
  private from = 0;

  constructor(fakes: ShownFakes) {
    this.fakes = fakes;
  }

  /** Adds a piece and returns the restored text that no later piece can change. */
  push(text: string): string {
    this.pending += text;
    // A fake that starts before this point ends before the last character, which decides its bound.
    return this.emit(this.pending.length - this.fakes.longestFake());
  }

  /** Returns the rest of the text. */
  end(): string {
    return this.emit(this.pending.length);
  }

  private emit(upTo: number): string {
    let out = "";
    let at = this.from;
    for (const [start, end, shown] of this.fakes.shownSpans(
      this.pending,
      this.from,
    )) {
      if (start >= upTo) break;
      out += this.pending.slice(at, start) + shown;
      at = end;
    }
    if (at < upTo) {
      out += this.pending.slice(at, upTo);
      at = upTo;
    }
    if (at > 0) {
      this.pending = this.pending.slice(at - 1);
      this.from = 1;
    }
    return out;
  }
}
