import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { anthropicStream, anthropicTurns } from "../../src/formats/index.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProxyProfile,
  type RunningProxy,
  startProxy,
} from "../../src/proxy/index.ts";

const SECRET = "TKT-123456";

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A loopback upstream that records each request and replies with `reply`. */
async function upstream(
  reply: string | ((body: string) => string) = '{"ok":true}',
  contentType = "application/json",
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    received.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });
    res.writeHead(200, { "content-type": contentType });
    res.end(typeof reply === "string" ? reply : reply(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port(server.address())}`, received };
}

function port(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string")
    throw new Error("server has no TCP address");
  return address.port;
}

function profile(upstreamUrl: string): ProxyProfile {
  return {
    name: "test-proxy",
    tools: ["Bash", "Read"],
    protectedPaths: [],
    format: { opaque: () => false },
    upstream: () => upstreamUrl,
    sessionId: (headers) => {
      const id = headers["x-session-id"];
      return typeof id === "string" ? id : undefined;
    },
    keptHeaders: ["x-session-id"],
    cwd: "/work",
    codec: anthropicStream,
    turns: anthropicTurns,
    commandKey: (tool) => (tool === "Bash" ? "command" : undefined),
    pathOf: (_tool, input) =>
      typeof input.file_path === "string" ? input.file_path : undefined,
  };
}

function dirs(
  config: unknown = {
    rules: [{ id: "ticket", type: "literal", values: [SECRET] }],
  },
): { configPath: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lmsk-proxy-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { configPath, stateDir: join(root, "state") };
}

async function proxy(
  upstreamUrl: string,
  paths = dirs(),
): Promise<RunningProxy> {
  const running = await startProxy(profile(upstreamUrl), {
    configPaths: [paths.configPath],
    stateDir: paths.stateDir,
    env: {},
    notify: () => undefined,
  });
  closers.push(() => running.close());
  return running;
}

function post(
  url: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
}

/** An Anthropic stream with one tool_use block, its input split in two deltas. */
function toolUseStream(id: string, tool: string, input: unknown): string {
  const json = JSON.stringify(input);
  const half = Math.floor(json.length / 2);
  const events = [
    ["message_start", { type: "message_start", message: { id: "m" } }],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name: tool, input: {} },
      },
    ],
    ...[json.slice(0, half), json.slice(half)].map((part) => [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: part },
      },
    ]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  return events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

/** The input that the agent gets for the tool_use block of a streamed reply. */
function streamedInput(text: string): unknown {
  const json = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)))
    .filter((data) => data.type === "content_block_delta")
    .map((data) => data.delta.partial_json)
    .join("");
  return JSON.parse(json);
}

/**
 * A conversation that resends a tool call and its result, as Claude Code does. It starts with a
 * summary, as after a compaction, so that only the call and its result hold the real.
 */
function history(input: unknown, result?: string): string {
  const results =
    result === undefined
      ? []
      : [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: result },
            ],
          },
        ];
  return JSON.stringify({
    messages: [
      { role: "user", content: "summary: echo a value" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input }],
      },
      ...results,
    ],
  });
}

const payload = JSON.stringify({
  messages: [{ role: "user", content: `ticket ${SECRET}` }],
});

describe("startProxy", () => {
  it("masks the request body, forwards it to the upstream path and returns the reply", async () => {
    const up = await upstream('{"reply":"done"}');
    const { url } = await proxy(up.url);

    const res = await post(`${url}/v1/messages?beta=true`, payload, {
      "anthropic-beta": "x-1",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"reply":"done"}');
    expect(up.received).toHaveLength(1);
    const [sent] = up.received;
    expect(sent.url).toBe("/v1/messages?beta=true");
    expect(sent.headers["anthropic-beta"]).toBe("x-1");
    expect(sent.headers["content-length"]).toBe(
      String(Buffer.byteLength(sent.body)),
    );
    expect(sent.body).not.toContain(SECRET);
    expect(JSON.parse(sent.body)).toEqual({
      messages: [{ role: "user", content: expect.stringMatching(/^ticket /) }],
    });
  });

  it("masks the header values with the body's fakes, and forwards the credential and kept headers unchanged", async () => {
    const up = await upstream();
    const { url } = await proxy(up.url);

    await post(`${url}/v1/responses`, payload, {
      "x-turn-metadata": `{"remote":"https://git.example/${SECRET}"}`,
      "x-api-key": SECRET,
      authorization: `Bearer ${SECRET}`,
      "x-session-id": SECRET,
    });

    const [sent] = up.received;
    const fake = JSON.parse(sent.body).messages[0].content.slice(
      "ticket ".length,
    );
    expect(fake).not.toBe(SECRET);
    expect(sent.headers["x-turn-metadata"]).toBe(
      `{"remote":"https://git.example/${fake}"}`,
    );
    expect(sent.headers["x-api-key"]).toBe(SECRET);
    expect(sent.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(sent.headers["x-session-id"]).toBe(SECRET);
  });

  it("forwards each request to the upstream that its headers select", async () => {
    const a = await upstream();
    const b = await upstream();
    const paths = dirs();
    const running = await startProxy(
      {
        ...profile(a.url),
        upstream: (headers) => (headers["x-route"] === "b" ? b.url : a.url),
      },
      {
        configPaths: [paths.configPath],
        stateDir: paths.stateDir,
        env: {},
        notify: () => undefined,
      },
    );
    closers.push(() => running.close());

    await post(`${running.url}/v1/responses`, payload, { "x-route": "b" });
    await post(`${running.url}/v1/responses`, payload);

    expect([a.received.length, b.received.length]).toEqual([1, 1]);
  });

  it.each([
    ["gzip", gzipSync],
    ["br", brotliCompressSync],
    ["zstd", zstdCompressSync],
  ])(
    "decodes a %s body and forwards it decoded and masked",
    async (encoding, encode) => {
      const up = await upstream();
      const { url } = await proxy(up.url);

      const res = await post(`${url}/v1/responses`, encode(payload), {
        "content-encoding": encoding,
      });

      expect(res.status).toBe(200);
      const [sent] = up.received;
      expect(sent.headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(sent.body)).toEqual({
        messages: [
          { role: "user", content: expect.stringMatching(/^ticket /) },
        ],
      });
      expect(sent.body).not.toContain(SECRET);
    },
  );

  it("forwards a request without a body unchanged", async () => {
    const up = await upstream('{"models":[]}');
    const { url } = await proxy(up.url);

    const res = await fetch(`${url}/v1/models`);

    expect(await res.text()).toBe('{"models":[]}');
    expect(up.received).toMatchObject([{ method: "GET", url: "/v1/models" }]);
  });

  it("refuses a request without the launch token and forwards nothing", async () => {
    const up = await upstream();
    const { url } = await proxy(up.url);
    const origin = new URL(url).origin;

    const res = await post(`${origin}/v1/messages`, payload);

    expect(res.status).toBe(403);
    expect(up.received).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", "ticket TKT-123456", {}, "PAYLOAD_SHAPE"],
    [
      "an unknown encoding",
      payload,
      { "content-encoding": "compress" },
      "PAYLOAD_SHAPE",
    ],
    [
      "an encoding named like an object key",
      payload,
      { "content-encoding": "constructor" },
      "PAYLOAD_SHAPE",
    ],
    [
      "a body over the size limit",
      " ".repeat(65 * 1024 * 1024),
      {},
      "PAYLOAD_SIZE",
    ],
  ])("fails closed on %s", async (_name, body, headers, code) => {
    const up = await upstream();
    const { url } = await proxy(up.url);

    const res = await post(`${url}/v1/messages`, body, headers);

    expect(res.status).toBe(400);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(await res.text()).toBe(`lmsk: ${code}`);
    expect(up.received).toEqual([]);
  });

  it("fails closed on a compressed body that decodes over the size limit", async () => {
    const up = await upstream();
    const { url } = await proxy(up.url);

    const res = await post(
      `${url}/v1/messages`,
      gzipSync(Buffer.alloc(65 * 1024 * 1024, 32)),
      { "content-encoding": "gzip" },
    );

    expect(await res.text()).toBe("lmsk: PAYLOAD_SIZE");
    expect(up.received).toEqual([]);
  });

  it("answers 502 when the upstream is unreachable, and lets the agent retry", async () => {
    const up = await upstream();
    const { url } = await proxy(up.url);
    await closers.shift()?.();

    const res = await post(`${url}/v1/messages`, payload);

    expect(res.status).toBe(502);
    expect(res.headers.get("x-should-retry")).toBe("true");
    expect(await res.text()).toBe("lmsk: UPSTREAM");
  });

  it.each([
    [
      "the configuration is invalid",
      { rules: "none" },
      payload,
      "CONFIG_INVALID",
    ],
    [
      "the scan times out",
      {
        rules: [{ id: "stall", type: "regex", pattern: "(a+)+b" }],
        scanTimeoutMs: 50,
      },
      JSON.stringify({
        messages: [{ role: "user", content: `${"a".repeat(40)}c` }],
      }),
      "SCAN_TIMEOUT",
    ],
  ])("fails closed when %s", async (_name, config, body, code) => {
    const up = await upstream();
    const { url } = await proxy(up.url, dirs(config));

    const res = await post(`${url}/v1/messages`, body);

    expect(res.status).toBe(400);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(await res.text()).toBe(`lmsk: ${code}`);
    expect(up.received).toEqual([]);
  });

  it("never sends the provider a short real that a tool call restored, on later requests or in a resumed run", async () => {
    const paths = dirs({
      rules: [
        {
          id: "password",
          type: "keyed",
          strategy: "shape",
          keys: ["password"],
          value: "[A-Za-z0-9]{6}",
        },
      ],
    });
    let fake = "";
    const up = await upstream((body) => {
      fake ||= JSON.parse(body).messages[0].content.slice("password=".length);
      return toolUseStream("t1", "Bash", { command: `echo ${fake}` });
    }, "text/event-stream");
    const headers = { "x-session-id": "session-1" };
    const first = await proxy(up.url, paths);

    const reply = await post(
      `${first.url}/v1/messages`,
      JSON.stringify({
        messages: [{ role: "user", content: "password=Sun5et" }],
      }),
      headers,
    );
    const restored = { command: "echo Sun5et" };
    expect(streamedInput(await reply.text())).toEqual(restored);
    for (const result of [undefined, "Sun5et\n"]) {
      const res = await post(
        `${first.url}/v1/messages`,
        history(restored, result),
        headers,
      );
      await res.text();
    }
    await first.close();
    const second = await proxy(up.url, paths);
    const resumed = await post(
      `${second.url}/v1/messages`,
      history(restored, "Sun5et\n"),
      headers,
    );
    await resumed.text();

    expect(up.received).toHaveLength(4);
    for (const { body } of up.received) {
      expect(body).not.toContain("Sun5et");
      expect(body).not.toContain("n5et");
    }
    for (const { body } of up.received.slice(1))
      expect(JSON.parse(body).messages[1].content[0].input).toEqual({
        command: `echo ${fake}`,
      });
  });

  it.each([
    ["in the same proxy", false],
    ["in another proxy", true],
  ])(
    "refuses a forked session, whose history holds the tool calls of another session, %s",
    async (_name, other) => {
      const up = await upstream(
        () => toolUseStream("t1", "Bash", { command: "echo hi" }),
        "text/event-stream",
      );
      const paths = dirs();
      const first = await proxy(up.url, paths);
      const parent = await post(`${first.url}/v1/messages`, payload, {
        "x-session-id": "parent",
      });
      await parent.text();
      const fork = other ? await proxy(up.url, paths) : first;

      const res = await post(
        `${fork.url}/v1/messages`,
        history({ command: "echo hi" }, "hi\n"),
        { "x-session-id": "fork" },
      );

      expect(res.status).toBe(400);
      expect(res.headers.get("x-should-retry")).toBe("false");
      expect(await res.text()).toBe("lmsk: FORKED_SESSION");
      expect(up.received).toHaveLength(1);
    },
  );

  it("forwards a session whose tool call is in no saved file, such as one from before lmsk, while other sessions have calls", async () => {
    const up = await upstream(
      () => toolUseStream("t2", "Bash", { command: "echo hi" }),
      "text/event-stream",
    );
    const server = await proxy(up.url, dirs());
    await (
      await post(`${server.url}/v1/messages`, payload, {
        "x-session-id": "other",
      })
    ).text();

    for (const _ of [1, 2]) {
      const res = await post(
        `${server.url}/v1/messages`,
        history({ command: "echo hi" }, "hi\n"),
        { "x-session-id": "resumed" },
      );
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(up.received).toHaveLength(3);
  });

  it("keeps the calls of two runs on one session, so a resumed run replays each", async () => {
    let n = 0;
    const up = await upstream(() => {
      n += 1;
      return toolUseStream(`t${n}`, "Bash", { command: `echo saved${n}` });
    }, "text/event-stream");
    const paths = dirs();
    const headers = { "x-session-id": "session-1" };
    const [a, b] = [await proxy(up.url, paths), await proxy(up.url, paths)];
    for (const run of [a, b, a])
      await (await post(`${run.url}/v1/messages`, payload, headers)).text();
    const resumed = await proxy(up.url, paths);

    const body = JSON.stringify({
      messages: [1, 2, 3].map((i) => ({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `t${i}`,
            name: "Bash",
            input: { command: "echo agent" },
          },
        ],
      })),
    });
    await (await post(`${resumed.url}/v1/messages`, body, headers)).text();

    expect(up.received).toHaveLength(4);
    expect(
      JSON.parse(up.received[3].body).messages.map(
        (message: { content: { input: unknown }[] }) =>
          message.content[0].input,
      ),
    ).toEqual([1, 2, 3].map((i) => ({ command: `echo saved${i}` })));
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", "{}"],
  ])(
    "fails closed when the store references of a session are %s",
    async (_name, text) => {
      const up = await upstream();
      const paths = dirs();
      const sessions = join(paths.stateDir, "sessions");
      mkdirSync(sessions, { recursive: true });
      const hash = createHash("sha256").update("session-1").digest("hex");
      writeFileSync(join(sessions, `${hash}.json`), text);
      const { url } = await proxy(up.url, paths);

      const res = await post(`${url}/v1/messages`, payload, {
        "x-session-id": "session-1",
      });

      expect(await res.text()).toBe("lmsk: STORE_REFERENCE_INVALID");
      expect(up.received).toEqual([]);
    },
  );

  it.each([
    ["not JSON", "{"],
    [
      "a call without an object input",
      JSON.stringify({ t1: { tool: "Bash", input: "echo" } }),
    ],
  ])(
    "fails closed when the saved tool calls of a session are %s",
    async (_name, text) => {
      const up = await upstream();
      const paths = dirs();
      const sessions = join(paths.stateDir, "sessions");
      mkdirSync(sessions, { recursive: true });
      const hash = createHash("sha256").update("session-1").digest("hex");
      writeFileSync(join(sessions, `${hash}.calls.json`), text);
      const { url } = await proxy(up.url, paths);

      const res = await post(`${url}/v1/messages`, payload, {
        "x-session-id": "session-1",
      });

      expect(await res.text()).toBe("lmsk: CALLS_INVALID");
      expect(up.received).toEqual([]);
    },
  );

  it("withholds the result of a call that opens a protected path, on every request", async () => {
    const up = await upstream(
      () => toolUseStream("t1", "Read", { file_path: ".env" }),
      "text/event-stream",
    );
    const { url } = await proxy(up.url);

    const reply = await post(`${url}/v1/messages`, payload);
    expect(streamedInput(await reply.text())).toEqual({ file_path: ".env" });
    const read = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: ".env" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "API_KEY=abc" },
          ],
        },
      ],
    });
    for (const _ of [1, 2])
      await (await post(`${url}/v1/messages`, read)).text();

    expect(up.received).toHaveLength(3);
    for (const { body } of up.received.slice(1)) {
      expect(body).not.toContain("API_KEY=abc");
      expect(JSON.parse(body).messages[1].content[0].content).toMatch(
        /^lmsk: withheld/,
      );
    }
  });

  it("withholds a tool result that holds a reversed or hex-encoded real, and keeps the others", async () => {
    const up = await upstream();
    const { url } = await proxy(up.url);
    await post(`${url}/v1/messages`, payload);
    const hidden = [
      [...SECRET].reverse().join(""),
      Buffer.from(SECRET).toString("hex"),
    ];
    const results = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [...hidden, "plain output"].map((content, i) => ({
            type: "tool_result",
            tool_use_id: `t${i}`,
            content,
          })),
        },
      ],
    });

    await post(`${url}/v1/messages`, results);

    const sent = up.received[1].body;
    for (const text of hidden) expect(sent).not.toContain(text);
    expect(
      JSON.parse(sent).messages[0].content.map(
        (block: { content: string }) => block.content,
      ),
    ).toEqual([
      expect.stringMatching(/^lmsk: withheld/),
      expect.stringMatching(/^lmsk: withheld/),
      "plain output",
    ]);
  });

  it("keeps a tool result with a reversed real when withholdHiddenCopies is false", async () => {
    const up = await upstream();
    const { url } = await proxy(
      up.url,
      dirs({
        withholdHiddenCopies: false,
        rules: [{ id: "ticket", type: "literal", values: [SECRET] }],
      }),
    );
    const reversed = [...SECRET].reverse().join("");

    await post(
      `${url}/v1/messages`,
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: reversed },
            ],
          },
        ],
      }),
    );

    expect(JSON.parse(up.received[0].body).messages[0].content[0].content).toBe(
      reversed,
    );
  });

  it("withholds a resent tool result once the vault learns the real that it hides", async () => {
    const up = await upstream();
    const { url } = await proxy(
      up.url,
      dirs({
        rules: [
          {
            id: "password",
            type: "keyed",
            strategy: "shape",
            keys: ["password"],
            value: "[A-Za-z0-9]{10}",
          },
        ],
      }),
    );
    const result = {
      type: "tool_result",
      tool_use_id: "t1",
      content: "Kq7Zp2Lm9X".split("").reverse().join(""),
    };
    const learn = { role: "user", content: "password=Kq7Zp2Lm9X" };

    for (const messages of [[], [learn]])
      await post(
        `${url}/v1/messages`,
        JSON.stringify({
          messages: [{ role: "user", content: [result] }, ...messages],
        }),
      );

    const [before, after] = up.received.map(
      ({ body }) => JSON.parse(body).messages[0].content[0].content,
    );
    expect(before).toBe(result.content);
    expect(after).toMatch(/^lmsk: withheld/);
  });

  it("gives a resumed agent session the fakes of its earlier run", async () => {
    const up = await upstream();
    const paths = dirs();
    const headers = { "x-session-id": "session-1" };
    const first = await proxy(up.url, paths);
    await post(`${first.url}/v1/messages`, payload, headers);
    await first.close();

    const second = await proxy(up.url, paths);
    await post(`${second.url}/v1/messages`, payload, headers);
    await post(`${second.url}/v1/messages`, payload, {
      "x-session-id": "session-2",
    });

    const [run1, run2, other] = up.received.map((r) => r.body);
    expect(run2).toBe(run1);
    expect(other).not.toBe(run1);
  });
});
