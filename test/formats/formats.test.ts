import { randomBytes } from "node:crypto";
import { shared } from "../core/shared-bytes.ts";
import { Masker, type Rule, Scanner, Vault } from "../../src/core/index.ts";
import { afterEach, describe, expect, it } from "vitest";
import { allFormats } from "../../src/formats/index.ts";

const TICKET: Rule = {
  id: "ticket",
  type: "literal",
  enabled: true,
  strategy: "opaque",
  values: ["TKT-123456"],
};

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.close();
  scanner = undefined;
});

function masker(rules: readonly Rule[] = [TICKET]) {
  scanner = new Scanner(2000);
  return new Masker(
    rules,
    scanner,
    new Vault(shared(randomBytes)),
    {},
    allFormats,
  );
}

describe("Anthropic shapes", () => {
  it("keeps signed thinking, redacted thinking, base64 images and toolu_ ids", async () => {
    const payload = {
      content: [
        { type: "thinking", thinking: "TKT-123456", signature: "TKT-123456" },
        { type: "text", text: "TKT-123456", signature: "TKT-123456" },
        { type: "redacted_thinking", data: "TKT-123456" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "TKT-123456",
          },
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_01 TKT-123456",
          content: "x",
        },
      ],
    };
    expect(await masker().maskPayload(payload)).toEqual(payload);
  });

  it("masks thinking text that no signature covers", async () => {
    const masked = await masker().maskPayload({
      content: [{ type: "thinking", thinking: "TKT-123456", signature: "" }],
    });
    expect(JSON.stringify(masked)).not.toContain("TKT-123456");
  });

  it("masks tool arguments named id or data", async () => {
    const masked = await masker().maskPayload({
      type: "tool_use",
      id: "toolu_01",
      input: { id: "TKT-123456", data: "TKT-123456" },
    });
    expect(JSON.stringify(masked)).not.toContain("TKT-123456");
  });

  it("keeps a base64 PDF document", async () => {
    const payload = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "TKT-123456",
      },
    };
    expect(await masker().maskPayload(payload)).toEqual(payload);
  });

  it.each([
    [
      "an Anthropic web search result",
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com",
            title: "t",
            encrypted_content: "TKT-123456",
          },
        ],
      },
    ],
    [
      "an Anthropic compaction block",
      {
        type: "compaction",
        content: "s",
        encrypted_content: "TKT-123456",
        signature: "TKT-123456",
      },
    ],
    [
      "an Anthropic advisor redacted result",
      { type: "advisor_redacted_result", encrypted_content: "TKT-123456" },
    ],
    [
      "an OpenAI Responses compaction item",
      { type: "compaction", id: "cmp_1", encrypted_content: "TKT-123456" },
    ],
    [
      "an OpenRouter reasoning.text detail",
      {
        type: "reasoning.text",
        text: "TKT-123456",
        signature: "TKT-123456",
        format: "anthropic-claude-v1",
        index: 0,
      },
    ],
    [
      "bedrock reasoning",
      {
        reasoningContent: {
          reasoningText: { text: "TKT-123456", signature: "TKT-123456" },
        },
      },
    ],
  ])("keeps the signed or encrypted content of %s", async (_name, block) => {
    const payload = { content: [block] };
    expect(await masker().maskPayload(payload)).toEqual(payload);
  });

  it.each([
    [
      "a base64 text document",
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "text/plain",
          data: "TKT-123456",
        },
      },
    ],
    [
      "a tool argument named signature",
      { type: "tool_use", id: "toolu_1", input: { signature: "TKT-123456" } },
    ],
    [
      "a tool argument named encrypted_content",
      {
        type: "tool_use",
        id: "toolu_1",
        input: { encrypted_content: "TKT-123456" },
      },
    ],
    [
      "an email tool argument with text and signature",
      {
        type: "tool_use",
        id: "toolu_1",
        input: {
          to: "a@example.com",
          subject: "TKT-123456",
          text: "TKT-123456",
          signature: "TKT-123456",
        },
      },
    ],
    [
      "a text data URL in a tool argument",
      {
        type: "tool_use",
        id: "toolu_1",
        input: { url: "data:text/plain,TKT-123456" },
      },
    ],
  ])("masks %s", async (_name, block) => {
    const masked = await masker().maskPayload({ content: [block] });
    expect(JSON.stringify(masked)).not.toContain("TKT-123456");
  });

  it("masks text under a tool schema field named signature or encrypted_content, which no provider signs", async () => {
    const masked = await masker().maskPayload({
      tools: [
        {
          input_schema: {
            properties: {
              signature: { description: "TKT-123456" },
              encrypted_content: { description: "TKT-123456" },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(masked)).not.toContain("TKT-123456");
  });
});

describe("OpenAI shapes", () => {
  it("keeps encrypted reasoning, data URLs and call_, fc_, rs_ and msg_ ids", async () => {
    const payload = {
      input: [
        {
          type: "reasoning",
          id: "rs_01 TKT-123456",
          encrypted_content: "TKT-123456",
        },
        { type: "message", id: "msg_01 TKT-123456", content: "x" },
        {
          type: "function_call",
          id: "fc_01 TKT-123456",
          call_id: "call_01 TKT-123456",
        },
        { type: "input_image", image_url: "data:image/png;base64,TKT-123456" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,TKT-123456" },
        },
        {
          type: "image_url",
          image_url: { url: "data:application/pdf;base64,TKT-123456" },
        },
      ],
      messages: [
        { role: "tool", tool_call_id: "call_01 TKT-123456", content: "x" },
      ],
    };
    expect(await masker().maskPayload(payload)).toEqual(payload);
  });

  it("masks an image_url that is not a data URL and an id without a provider prefix", async () => {
    const masked = await masker().maskPayload({
      image_url: "https://example.test/a.png?token=TKT-123456",
      id: "TKT-123456",
    });
    expect(JSON.stringify(masked)).not.toContain("TKT-123456");
  });
});

describe("image data of each provider", () => {
  const imageBytes = Buffer.from("token TKT-123456 end ".repeat(330_000));
  const image = imageBytes.toString("base64");
  const dataUrl = `data:image/png;base64,${image}`;
  it.each([
    [
      "anthropic",
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: image },
      },
    ],
    ["openai Chat", { type: "image_url", image_url: { url: dataUrl } }],
    ["openai Responses", { type: "input_image", image_url: dataUrl }],
    ["mistral", { type: "image_url", imageUrl: dataUrl }],
    ["google", { inlineData: { mimeType: "image/png", data: image } }],
    ["pi context", { type: "image", mimeType: "image/png", data: image }],
    [
      "bedrock",
      {
        image: { source: { bytes: new Uint8Array(imageBytes) }, format: "png" },
      },
    ],
  ])(
    "passes %s image data unchanged and outside the size limit",
    async (_name, block) => {
      const payload = { messages: [{ role: "user", content: [block] }] };
      await expect(masker().maskPayload(payload)).resolves.toEqual(payload);
    },
  );

  it("masks image-like tool arguments", async () => {
    const token = "TKT-123456";
    const masked = await masker().maskPayload({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "write",
          input: { mimeType: "image/png", data: token },
        },
      ],
    });
    expect(JSON.stringify(masked)).not.toContain(token);
  });
});
