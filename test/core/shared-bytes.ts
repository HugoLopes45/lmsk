import type { BytesFor } from "../../src/core/keyed-bytes.ts";
import type { RandomBytes } from "../../src/core/shape.ts";

/** One stream for every real, so that a test fixes the fakes by the order it asks for them. */
export function shared(random: RandomBytes): BytesFor {
  return () => random;
}
