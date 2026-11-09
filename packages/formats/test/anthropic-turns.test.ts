import { describe, expect, it } from "vitest";
import { anthropicTurns } from "../src/index.ts";

const payload = () => ({
  model: "m",
  system: [{ type: "text", text: "s" }],
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "file a" },
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "a b" }],
        },
      ],
    },
  ],
});

describe("anthropicTurns", () => {
  it("replaces each tool call input and tool result by call id, in a copy", () => {
    const original = payload();
    const seen: string[] = [];
    const edited = anthropicTurns(original, {
      input: (id, value) => {
        seen.push(`input ${id} ${JSON.stringify(value)}`);
        return { id };
      },
      result: (id, value) => {
        seen.push(`result ${id} ${JSON.stringify(value)}`);
        return `withheld ${id}`;
      },
    });
    expect(seen).toEqual([
      'input t1 {"file_path":"a"}',
      'input t2 {"command":"ls"}',
      'result t1 "file a"',
      'result t2 [{"type":"text","text":"a b"}]',
    ]);
    const [user] = payload().messages;
    expect(edited).toEqual({
      ...payload(),
      messages: [
        user,
        {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            { type: "tool_use", id: "t1", name: "Read", input: { id: "t1" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { id: "t2" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "withheld t1" },
            { type: "tool_result", tool_use_id: "t2", content: "withheld t2" },
          ],
        },
      ],
    });
    expect(original).toEqual(payload());
  });

  it("leaves a payload without tool turns, or with an unexpected shape, unchanged", () => {
    const edit = {
      input: () => "x",
      result: () => "x",
    };
    for (const value of [
      null,
      "text",
      { messages: "no" },
      {
        messages: [null, { content: [null, { type: "tool_use", input: {} }] }],
      },
    ])
      expect(anthropicTurns(value, edit)).toEqual(value);
  });
});
