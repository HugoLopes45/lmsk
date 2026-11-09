import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type ImageContent,
  type JsonObject,
  type JsonValue,
  type NestedToolCalls,
  type SystemMessage,
  type TextContent,
} from "@earendil-works/pi-ai";
import {
  assertPayloadSize,
  CodedError,
  DEFAULT_MASK,
  type TextMap,
  textsOf,
} from "@lmsk/core";

/** The decisions that pi reads from an assistant error text. */
interface ErrorDecisions {
  overflow: boolean;
  retryable: boolean;
}

type AssistantBlock = AssistantMessage["content"][number];
/** The roles whose text is masked before the session saves it. Other roles keep their existing behavior. */
export type MaskedMessage = Extract<
  MessageEndEvent["message"],
  { role: "system" | "user" | "assistant" | "toolResult" | "custom" }
>;
export type ToolResultFields = {
  content: (TextContent | ImageContent)[];
  structuredContent?: JsonValue;
  details?: unknown;
};

export function isMaskedMessage(
  message: MessageEndEvent["message"],
): message is MaskedMessage {
  return (
    message.role === "system" ||
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult" ||
    message.role === "custom"
  );
}

/** Masks texts and returns them in input order, such as `Guard.maskTexts`. */
export type MaskTexts = (texts: string[]) => Promise<string[]>;

/**
 * Runs `walk` over `value` twice: first to collect its texts, then to rebuild it with
 * the masked texts in the same order. One `mask` call sees every text of the value.
 */
export async function maskTexts<T, U>(
  mask: MaskTexts,
  value: T,
  walk: (value: T, map: TextMap) => U,
): Promise<U> {
  const masked = await mask(textsOf(value, walk));
  let index = 0;
  return walk(value, () => masked[index++]);
}

/** Images stay as they are: their base64 data is not text. */
function mapBlocks(
  blocks: (TextContent | ImageContent)[],
  map: TextMap,
): (TextContent | ImageContent)[] {
  return blocks.map((block) =>
    block.type === "text" ? { ...block, text: map(block.text) } : block,
  );
}

/** Keys are schema, not text, so only string values are mapped. */
function mapJsonStrings(value: JsonObject, map: TextMap): JsonObject;
function mapJsonStrings(value: JsonValue, map: TextMap): JsonValue;
function mapJsonStrings(value: unknown, map: TextMap): unknown;
function mapJsonStrings(value: unknown, map: TextMap): unknown {
  if (typeof value === "string") return map(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => mapJsonStrings(item, map));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]): [string, unknown] => [
      key,
      mapJsonStrings(item, map),
    ]),
  );
}

function mapNestedCalls(
  calls: NestedToolCalls | undefined,
  map: TextMap,
): NestedToolCalls | undefined {
  if (calls === undefined) return undefined;
  return {
    ...calls,
    calls: calls.calls.map((call) => ({
      ...call,
      arguments:
        call.arguments === undefined
          ? undefined
          : mapJsonStrings(call.arguments, map),
      error: call.error === undefined ? undefined : map(call.error),
    })),
  };
}

function mapSystemText(message: SystemMessage, map: TextMap): SystemMessage {
  return {
    ...message,
    content:
      typeof message.content === "string"
        ? map(message.content)
        : message.content.map((block) => ({ ...block, text: map(block.text) })),
    sections:
      message.sections === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(message.sections).map(
              ([name, text]): [string, string | null] => [
                name,
                text === null ? null : map(text),
              ],
            ),
          ),
  };
}

/**
 * A provider signature covers the bytes of its block. A change under it would break
 * replay, so the message fails instead.
 */
function assertUnchangedWhenSigned(
  signature: string | undefined,
  changed: boolean,
): void {
  if (signature && changed) throw new CodedError("SIGNED_CHANGE");
}

/** A non-empty thinking signature makes thinking byte-exact for the provider, so it is not mapped. */
function mapAssistantBlock(
  block: AssistantBlock,
  map: TextMap,
): AssistantBlock {
  switch (block.type) {
    case "text": {
      const text = map(block.text);
      assertUnchangedWhenSigned(block.textSignature, text !== block.text);
      return { ...block, text };
    }
    case "thinking":
      return block.thinkingSignature
        ? block
        : { ...block, thinking: map(block.thinking) };
    case "toolCall": {
      const args = mapJsonStrings(block.arguments, map);
      assertUnchangedWhenSigned(
        block.thoughtSignature,
        JSON.stringify(args) !== JSON.stringify(block.arguments),
      );
      return { ...block, arguments: args };
    }
  }
}

/** An absent text stays absent. Only a present text is mapped. */
function mapOptionalText(
  text: string | undefined,
  map: TextMap,
): string | undefined {
  return text === undefined ? undefined : map(text);
}

function mapMessageText(message: MaskedMessage, map: TextMap): MaskedMessage {
  switch (message.role) {
    case "system":
      return mapSystemText(message, map);
    case "user":
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? map(message.content)
            : mapBlocks(message.content, map),
      };
    case "assistant":
      return {
        ...message,
        content: message.content.map((block) => mapAssistantBlock(block, map)),
        errorMessage: mapOptionalText(message.errorMessage, map),
      };
    case "toolResult":
      return {
        ...message,
        content: mapBlocks(message.content, map),
        details:
          message.details === undefined
            ? undefined
            : mapJsonStrings(message.details, map),
        nestedCalls: mapNestedCalls(message.nestedCalls, map),
      };
    case "custom":
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? map(message.content)
            : mapBlocks(message.content, map),
        details:
          message.details === undefined
            ? undefined
            : mapJsonStrings(message.details, map),
      };
  }
}

export function mapToolResultText(
  result: ToolResultFields,
  map: TextMap,
): ToolResultFields {
  return {
    content: mapBlocks(result.content, map),
    structuredContent:
      result.structuredContent === undefined
        ? undefined
        : mapJsonStrings(result.structuredContent, map),
    details:
      result.details === undefined
        ? undefined
        : mapJsonStrings(result.details, map),
  };
}

/**
 * A withheld tool call becomes text. A call kept with empty arguments would replay
 * with its provider signature, which covers the original arguments.
 */
function withheldBlock(block: AssistantBlock): AssistantBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: DEFAULT_MASK };
    case "thinking":
      return { type: "thinking", thinking: DEFAULT_MASK };
    case "toolCall":
      return { type: "text", text: DEFAULT_MASK };
  }
}

/**
 * The neutral form of a message. It is written in place before any await, so a failed
 * mask persists this form and never the raw text.
 */
export function withheldMessage(message: MaskedMessage): MaskedMessage {
  switch (message.role) {
    case "system":
      return { ...message, content: DEFAULT_MASK, sections: undefined };
    case "user":
      return { ...message, content: DEFAULT_MASK };
    case "assistant":
      return {
        ...message,
        content: message.content.map(withheldBlock),
        errorMessage: undefined,
      };
    case "toolResult":
      return {
        ...message,
        content: [{ type: "text", text: DEFAULT_MASK }],
        details: undefined,
        nestedCalls: undefined,
      };
    case "custom":
      return { ...message, content: DEFAULT_MASK, details: undefined };
  }
}

/**
 * The overflow and retry decisions of an assistant message. Usage-derived overflow
 * does not read the error text, so only the error text can change these decisions.
 */
function errorDecisions(message: AssistantMessage): ErrorDecisions {
  return {
    overflow: isContextOverflow(message),
    retryable: isRetryableAssistantError(message),
  };
}

/**
 * The text that replaces an error whose masking changed a decision. It holds no raw
 * text and keeps the decisions of the raw error.
 */
function withheldErrorText({ overflow, retryable }: ErrorDecisions): string {
  const status = retryable ? "503" : "400";
  const kind = overflow ? "context_length_exceeded" : "provider error";
  return `${status} ${kind}, text withheld`;
}

/**
 * Masks a persisted message. Masking can change the error text that pi's classifiers
 * read, so the masked error keeps the overflow and retry decisions of the raw error.
 */
export async function maskMessage(
  mask: MaskTexts,
  message: MaskedMessage,
): Promise<MaskedMessage> {
  if (message.role === "toolResult" || message.role === "custom")
    assertPayloadSize(message.details);
  const masked = await maskTexts(mask, message, mapMessageText);
  if (message.role !== "assistant" || masked.role !== "assistant")
    return masked;
  const raw = errorDecisions(message);
  const kept = errorDecisions(masked);
  if (kept.overflow === raw.overflow && kept.retryable === raw.retryable)
    return masked;
  return { ...masked, errorMessage: withheldErrorText(raw) };
}

/** The neutral form of a tool result. `details` is a string, so the runner does not keep the raw details. */
export function withheldResultFields(): ToolResultFields & { details: string } {
  return {
    content: [{ type: "text", text: DEFAULT_MASK }],
    structuredContent: undefined,
    details: DEFAULT_MASK,
  };
}
