import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import { CodedError } from "../core/index.ts";

/** Above any request an agent sends; it bounds memory against a compressed body that expands without end. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

const DECODERS = new Map<
  string,
  (body: Buffer, options: { maxOutputLength: number }) => Buffer
>([
  ["identity", (body) => body],
  ["gzip", gunzipSync],
  ["deflate", inflateSync],
  ["br", brotliDecompressSync],
  ["zstd", zstdDecompressSync],
]);

/** Reads a request body. Rejects with PAYLOAD_SIZE above `MAX_BODY_BYTES`. */
export async function readBody(
  stream: AsyncIterable<Buffer | string>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new CodedError("PAYLOAD_SIZE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The JSON value of a body sent with `encoding`. Rejects with PAYLOAD_SHAPE on an unknown or
 * stacked encoding and on text that is not JSON, and with PAYLOAD_SIZE when it decodes too large.
 */
export function decodeJson(
  body: Buffer,
  encoding: string | undefined,
): unknown {
  const decode = DECODERS.get((encoding ?? "identity").trim().toLowerCase());
  if (decode === undefined) throw new CodedError("PAYLOAD_SHAPE");
  let text: string;
  try {
    text = decode(body, { maxOutputLength: MAX_BODY_BYTES }).toString("utf8");
  } catch (error) {
    throw new CodedError(
      error instanceof RangeError ? "PAYLOAD_SIZE" : "PAYLOAD_SHAPE",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CodedError("PAYLOAD_SHAPE");
  }
}
