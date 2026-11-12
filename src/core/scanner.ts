import { Worker } from "node:worker_threads";
import { type Allowlist, isRecord, type ValidatorName } from "./config.ts";
import { CodedError } from "./errors.ts";

/** Semantics of the optional fields match the same fields of a regex rule. */
export interface ScanPattern {
  source: string;
  flags: string;
  group: number | "auto";
  keywords?: string[];
  entropy?: number;
  validate?: ValidatorName;
  allow?: Allowlist[];
}

/** `[start, end, patternIndex]`, sorted by start, then longest first. */
export type Span = [number, number, number];

export type ScanErrorCode = "SCAN_TIMEOUT" | "SCAN_PATTERN" | "SCAN_CRASH";

export class ScanError extends CodedError<ScanErrorCode> {}

const WORKER_URL = new URL("./scan-worker.mjs", import.meta.url);
const MEMORY_MB = 128;
/** V8 otherwise grows the worker's new space to about 45 MB, as each scan copies large texts in. */
const YOUNG_MEMORY_MB = 8;

interface Pending {
  resolve: (spans: Span[][]) => void;
  reject: (error: ScanError) => void;
  timer: NodeJS.Timeout;
}

function isSpanList(value: unknown): value is Span[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (spans) =>
        Array.isArray(spans) &&
        spans.every(
          (span) =>
            Array.isArray(span) &&
            span.length === 3 &&
            span.every((part) => Number.isInteger(part)),
        ),
    )
  );
}

/**
 * Runs regex scans in a worker thread with a memory cap and a wall-clock
 * timeout. Every failure rejects with a ScanError; callers must fail closed.
 */
export class Scanner {
  private worker: Worker | undefined;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  scan(patterns: ScanPattern[], texts: string[]): Promise<Span[][]> {
    if (this.closed)
      return Promise.reject(new ScanError("SCAN_CRASH", "scanner closed"));
    if (texts.length === 0) return Promise.resolve([]);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new ScanError("SCAN_TIMEOUT", `no result after ${this.timeoutMs} ms`),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, patterns, texts });
    });
  }

  close(): void {
    this.closed = true;
    this.fail(new ScanError("SCAN_CRASH", "scanner closed"));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_URL, {
      resourceLimits: {
        maxOldGenerationSizeMb: MEMORY_MB,
        maxYoungGenerationSizeMb: YOUNG_MEMORY_MB,
      },
    });
    worker.unref();
    worker.on("message", (message: unknown) => this.receive(message));
    worker.on("error", () => {
      if (this.worker === worker)
        this.fail(new ScanError("SCAN_CRASH", "worker error"));
    });
    worker.on("exit", (code) => {
      if (this.worker === worker)
        this.fail(new ScanError("SCAN_CRASH", `worker exit ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== "number") {
      this.fail(new ScanError("SCAN_CRASH", "malformed worker message"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true && isSpanList(message.result))
      pending.resolve(message.result);
    else if (
      message.code === "SCAN_PATTERN" &&
      typeof message.index === "number"
    )
      pending.reject(new ScanError("SCAN_PATTERN", `pattern ${message.index}`));
    else pending.reject(new ScanError("SCAN_CRASH", "malformed worker result"));
  }

  /** Rejects every pending scan and drops the worker; the next scan starts a new one unless the scanner is closed. */
  private fail(error: ScanError): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void worker?.terminate();
  }
}

const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;
/**
 * Not inside a run of word characters: where a literal starts or ends with a word character, a word
 * boundary. One copy around the whole alternation, as V8 fails to scan with a copy per literal of a large vault.
 */
const EDGE = "(?:(?<![\\p{L}\\p{N}_])|(?![\\p{L}\\p{N}_]))";

export function escapeRegex(value: string): string {
  return value.replace(SYNTAX, "\\$&");
}

/** One alternation of literals, longest first, bounded where the edge is a word character. */
export function literalPattern(
  values: string[],
  ignoreCase: boolean,
): ScanPattern {
  const alternatives = [...new Set(values)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  return {
    source: `${EDGE}(?:${alternatives.join("|")})${EDGE}`,
    flags: ignoreCase ? "iu" : "u",
    group: 0,
  };
}

function caseless(word: string): string {
  return [...word]
    .map((char) => {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      return lower === upper ? escapeRegex(char) : `[${lower}${upper}]`;
    })
    .join("");
}

/**
 * `key: value`, `key=value` and JSON pairs for camelCase keys in camel, snake,
 * kebab and upper case, with an optional key prefix (`parentClientId`,
 * `X_API_KEY`). Group 1 is the value.
 */
export function keyedPattern(keys: string[], value: string): ScanPattern {
  const names = keys.map((key) =>
    key
      .split(/(?=[A-Z])/)
      .map(caseless)
      .join("[_-]?"),
  );
  const key = `(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+[_-]?)??(?:${names.join("|")})(?![A-Za-z0-9])`;
  const source = `${key}["']?\\s*[:=]\\s*["']?(${value})(?![A-Za-z0-9_.-])`;
  return { source, flags: "u", group: 1 };
}
