import { randomBytes } from "node:crypto";
import { Masker, type Rule, Scanner, Vault } from "@lmsk/core";
import { afterEach, describe, expect, it } from "vitest";
import { allFormats } from "../src/index.ts";

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
  return new Masker(rules, scanner, new Vault(randomBytes), {}, allFormats);
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
