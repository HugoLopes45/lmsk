import { createHmac } from "node:crypto";
import type { RandomBytes } from "./shape.ts";

/** Bytes for the fakes of one real. */
export type BytesFor = (real: string) => RandomBytes;

/**
 * An endless HMAC-SHA256 stream per real: block `i` is HMAC(key, i, real). The same key and
 * real give the same bytes, so a real gets the same fake in every process that holds the key.
 */
export function keyedBytes(key: Uint8Array): BytesFor {
  return (real) => {
    let block = 0;
    let pending = Buffer.alloc(0);
    return (size) => {
      while (pending.length < size) {
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(block++);
        const next = createHmac("sha256", key)
          .update(counter)
          .update(real, "utf8")
          .digest();
        pending = Buffer.concat([pending, next]);
      }
      const out = pending.subarray(0, size);
      pending = pending.subarray(size);
      return out;
    };
  };
}
