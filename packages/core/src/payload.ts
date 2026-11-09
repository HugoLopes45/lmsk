import { isRecord } from "./config.ts";
import { CodedError } from "./errors.ts";

export class PayloadError extends CodedError<
  "PAYLOAD_SIZE" | "PAYLOAD_SHAPE"
> {}

export type TextMap = (text: string) => string;

/** A provider wire format: which payload fields the provider needs byte-exact. */
export interface PayloadFormat {
  /** Whether `key: value` inside `parent` must reach the provider unchanged, with all its children. */
  opaque(key: string, value: unknown, parent: Record<string, unknown>): boolean;
}

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertJsonContainer(
  value: unknown,
  ancestors: readonly object[],
): asserts value is Record<string, unknown> | unknown[] {
  const plain =
    Array.isArray(value) || (isRecord(value) && isPlainObject(value));
  if (!plain || ancestors.includes(value))
    throw new PayloadError(
      "PAYLOAD_SHAPE",
      "payload holds a value JSON cannot carry, or a cycle",
    );
}

/**
 * Copies a JSON value and passes each string outside an opaque key to `mapText`.
 * Throws PAYLOAD_SHAPE on cycles and on values JSON cannot carry.
 */
function copyJson(
  value: unknown,
  mapText: TextMap,
  format: PayloadFormat,
  opaque: boolean,
  ancestors: readonly object[],
): unknown {
  if (typeof value === "string") return opaque ? value : mapText(value);
  if (opaque && value instanceof Uint8Array) return value;
  if (isJsonScalar(value)) return value;
  assertJsonContainer(value, ancestors);
  const path = [...ancestors, value];
  if (Array.isArray(value))
    return value.map((item) => copyJson(item, mapText, format, opaque, path));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        key,
        copyJson(
          item,
          mapText,
          format,
          opaque || format.opaque(key, item, value),
          path,
        ),
      ]),
  );
}

/** Rejects a value whose JSON text is over the payload limit. An absent value has no JSON text. */
export function assertPayloadSize(payload: unknown): void {
  if (payload === undefined) return;
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES)
    throw new PayloadError(
      "PAYLOAD_SIZE",
      `payload is over ${MAX_PAYLOAD_BYTES} bytes`,
    );
}

/** Copies a provider payload and passes each string outside the opaque fields of `format` to `map`, in order. */
export function mapPayload(
  payload: unknown,
  map: TextMap,
  format: PayloadFormat,
): unknown {
  return copyJson(payload, map, format, false, []);
}

/** The texts of `value` in the order that `walk` maps them. */
export function textsOf<T>(
  value: T,
  walk: (value: T, map: TextMap) => unknown,
): string[] {
  const texts: string[] = [];
  walk(value, (text) => {
    texts.push(text);
    return text;
  });
  return texts;
}
