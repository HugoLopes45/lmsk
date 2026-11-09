import { isRecord, type PayloadFormat } from "@lmsk/core";

/* The rules follow the provider wire formats (Anthropic Messages, OpenAI Chat and Responses, Mistral, Google, Bedrock). One set serves all of them: a host can convert ids between providers, so an Anthropic `tool_use_id` can hold an OpenAI `call_` id. */

/** Always byte-exact: the provider signs or encrypts these values, so a change breaks replay. */
const ALWAYS_OPAQUE_KEYS = new Set(["signature", "encrypted_content"]);

/** Byte-exact only when the value is a data URL. */
const DATA_URL_KEYS = new Set(["image_url", "imageUrl", "url"]);

/** Byte-exact only when the value starts with a provider id prefix. */
const PROVIDER_ID_KEYS = new Set([
  "id",
  "call_id",
  "tool_call_id",
  "tool_use_id",
]);
const PROVIDER_ID_PREFIXES = ["toolu_", "call_", "fc_", "rs_", "msg_"];

/** Text that a sibling non-empty `signature` covers, so it stays byte-exact. */
const SIGNED_TEXT_KEYS = new Set(["thinking", "text"]);

function isImageType(mimeType: unknown): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

/** Image bytes and redacted thinking. */
function isBinaryData(
  key: string,
  value: unknown,
  parent: Record<string, unknown>,
): boolean {
  if (key === "data")
    return (
      parent.type === "redacted_thinking" ||
      parent.type === "base64" ||
      (parent.type === "image" && isImageType(parent.mimeType))
    );
  if (key === "inlineData")
    return isRecord(value) && isImageType(value.mimeType);
  return (
    key === "image" &&
    isRecord(value) &&
    isRecord(value.source) &&
    value.source.bytes instanceof Uint8Array
  );
}

function isSignedText(key: string, parent: Record<string, unknown>): boolean {
  return (
    SIGNED_TEXT_KEYS.has(key) &&
    typeof parent.signature === "string" &&
    parent.signature !== ""
  );
}

function isProviderString(key: string, value: string): boolean {
  if (DATA_URL_KEYS.has(key)) return value.startsWith("data:");
  return (
    PROVIDER_ID_KEYS.has(key) &&
    PROVIDER_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

/** The fields that any supported provider needs byte-exact. */
export const allFormats: PayloadFormat = {
  opaque(key, value, parent) {
    if (ALWAYS_OPAQUE_KEYS.has(key) || isSignedText(key, parent)) return true;
    if (isBinaryData(key, value, parent)) return true;
    return typeof value === "string" && isProviderString(key, value);
  },
};

export { anthropicStream } from "./anthropic-stream.ts";
export { anthropicTurns } from "./anthropic-turns.ts";
export type {
  Restore,
  SseEvent,
  StreamCodec,
  ToolInput,
  ToolTurns,
  TurnEdit,
} from "./stream.ts";
