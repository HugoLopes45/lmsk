import { isRecord, type PayloadFormat } from "../core/index.ts";

/* The rules follow the provider wire formats (Anthropic Messages, OpenAI Chat and Responses, Mistral, Google, Bedrock). One set serves all of them: a host can convert ids between providers, so an Anthropic `tool_use_id` can hold an OpenAI `call_` id. */

/** Byte-exact when the value is a string in a signed block (`isSignedBlock`): the provider signs or encrypts these values, so a change breaks replay. Elsewhere, such as in a tool argument or a tool schema property, it is ordinary text. */
const SIGNED_KEYS = new Set(["signature", "encrypted_content"]);
const SIGNED_TYPES = new Set([
  "thinking",
  "reasoning",
  "text",
  "web_search_result",
  "compaction",
  "advisor_redacted_result",
  "reasoning.text",
]);

/** Byte-exact only when the value is an image or PDF data URL. */
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

/** The media types that a provider reads as binary: base64 text of another type is ordinary text. */
function isBinaryType(mimeType: unknown): boolean {
  return isImageType(mimeType) || mimeType === "application/pdf";
}

function isBinarySource(parent: Record<string, unknown>): boolean {
  return (
    parent.type === "redacted_thinking" ||
    (parent.type === "base64" && isBinaryType(parent.media_type)) ||
    (parent.type === "image" && isImageType(parent.mimeType))
  );
}

/** Image or PDF bytes and redacted thinking. */
function isBinaryData(
  key: string,
  value: unknown,
  parent: Record<string, unknown>,
): boolean {
  if (key === "data") return isBinarySource(parent);
  if (key === "inlineData")
    return isRecord(value) && isImageType(value.mimeType);
  return (
    key === "image" &&
    isRecord(value) &&
    isRecord(value.source) &&
    value.source.bytes instanceof Uint8Array
  );
}

/** A thinking, reasoning, OpenRouter `reasoning.text`, encrypted search, compaction or advisor block, or a Bedrock `reasoningText`, which holds only `text` and `signature`. */
function isSignedBlock(parent: Record<string, unknown>): boolean {
  if (typeof parent.type === "string") return SIGNED_TYPES.has(parent.type);
  return (
    typeof parent.text === "string" &&
    Object.keys(parent).every((key) => key === "text" || key === "signature")
  );
}

function isSignedText(key: string, parent: Record<string, unknown>): boolean {
  return (
    SIGNED_TEXT_KEYS.has(key) &&
    isSignedBlock(parent) &&
    typeof parent.signature === "string" &&
    parent.signature !== ""
  );
}

function isProviderString(key: string, value: string): boolean {
  if (DATA_URL_KEYS.has(key))
    return /^data:(?:image\/[^;,]*|application\/pdf)[;,]/.test(value);
  return (
    PROVIDER_ID_KEYS.has(key) &&
    PROVIDER_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

/** The fields that any supported provider needs byte-exact. */
export const allFormats: PayloadFormat = {
  opaque(key, value, parent) {
    if (
      (SIGNED_KEYS.has(key) &&
        typeof value === "string" &&
        isSignedBlock(parent)) ||
      isSignedText(key, parent)
    )
      return true;
    if (isBinaryData(key, value, parent)) return true;
    return typeof value === "string" && isProviderString(key, value);
  },
};

export { anthropicStream } from "./anthropic-stream.ts";
export type { Restore, SseEvent, StreamCodec, ToolInput } from "./stream.ts";
