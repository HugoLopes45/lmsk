import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { anthropicStream } from "../../src/formats/index.ts";
import { claudeProfile } from "../../src/claude-code/profile.ts";
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
  const server: Server = createServer((req, res) => void respond(req, res));
  async function respond(req: IncomingMessage, res: ServerResponse) {
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
  }
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
    upstream: upstreamUrl,
    keptHeaders: ["x-session-id"],
    cwd: "/work",
    codec: anthropicStream,
    commandKey: (tool) => (tool === "Bash" ? "command" : undefined),
    pathOf: (_tool, input) =>
      typeof input.file_path === "string" ? input.file_path : undefined,
    rootsOf: () => [],
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

it("rejects startup when another server owns the port", async () => {
  const occupied = await upstream();
  const paths = dirs();
  const source = new URL("../../src/proxy/server.ts", import.meta.url).href;
  const adapter = new URL("../../src/claude-code/profile.ts", import.meta.url)
    .href;
  const script = `
    import assert from "node:assert/strict";
    import { startProxy } from ${JSON.stringify(source)};
    import { claudeProfile } from ${JSON.stringify(adapter)};
    await assert.rejects(startProxy(claudeProfile({
      cwd: "/", env: {}, protectedPaths: [],
    }), {
      configPaths: [], stateDir: ${JSON.stringify(paths.stateDir)}, env: {},
      notify: () => {}, token: "test-token", port: ${new URL(occupied.url).port},
    }), { code: "PORT_TAKEN" });
  `;
  await expect(
    promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        timeout: 5000,
      },
    ),
  ).resolves.toMatchObject({ stdout: "", stderr: "" });
});

async function proxy(
  upstreamUrl: string,
  paths = dirs(),
  notify: (message: string) => void = () => undefined,
): Promise<RunningProxy> {
  const running = await startProxy(profile(upstreamUrl), {
    configPaths: [paths.configPath],
    stateDir: paths.stateDir,
    env: {},
    notify,
    port: 0,
    token: "test-token",
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
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "m" } }],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name: tool, input: {} },
      },
    ],
    ...[json.slice(0, half), json.slice(half)].map(
      (part): [string, unknown] => [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: part },
        },
      ],
    ),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_stop", { type: "message_stop" }],
  ];
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

  it("refuses an upstream redirect, which would send the credential to another origin", async () => {
    const other = await upstream();
    const redirect = createServer((_req, res) => {
      res.writeHead(307, { location: `${other.url}/v1/messages` });
      res.end();
    });
    await new Promise<void>((resolve) =>
      redirect.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () => new Promise((resolve) => redirect.close(() => resolve())),
    );
    const { url } = await proxy(`http://127.0.0.1:${port(redirect.address())}`);

    const res = await post(`${url}/v1/messages`, payload, {
      "x-api-key": SECRET,
    });

    expect(res.status).toBe(502);
    expect(other.received).toEqual([]);
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

  it("masks a request once a failed config is fixed, without a restart", async () => {
    const up = await upstream();
    const paths = dirs({ unknown: 1 });
    const { url } = await proxy(up.url, paths);

    expect((await post(`${url}/v1/messages`, payload)).status).toBe(400);
    writeFileSync(
      paths.configPath,
      JSON.stringify({
        rules: [{ id: "ticket", type: "literal", values: [SECRET] }],
      }),
    );
    const res = await post(`${url}/v1/messages`, payload);

    expect(res.status).toBe(200);
    expect(up.received).toHaveLength(1);
    expect(up.received[0].body).not.toContain(SECRET);
  });

  it("notifies each request that a blocked guard refuses, with its code only", async () => {
    const up = await upstream();
    const notices: string[] = [];
    const { url } = await proxy(up.url, dirs({ unknown: 1 }), (message) =>
      notices.push(message),
    );
    notices.splice(0);

    expect((await post(`${url}/v1/messages`, payload)).status).toBe(400);
    expect((await post(`${url}/v1/messages`, payload)).status).toBe(400);
    expect(notices).toEqual(["lmsk: CONFIG_INVALID", "lmsk: CONFIG_INVALID"]);
  });

  it("notifies only the first request that lacks the launch token", async () => {
    const up = await upstream();
    const notices: string[] = [];
    const { url } = await proxy(up.url, dirs(), (message) =>
      notices.push(message),
    );
    const origin = new URL(url).origin;

    expect((await post(`${origin}/v1/messages`, payload)).status).toBe(403);
    expect((await post(`${origin}/v1/messages`, payload)).status).toBe(403);
    expect(notices).toEqual(["lmsk: FORBIDDEN"]);
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

  it.each([
    [{}, true],
    [{ path: "src" }, true],
    [{ path: "/" }, false],
  ])(
    "restores a Grep with %j from a proxy that runs in /: %s",
    async (where, restored) => {
      const paths = dirs();
      let fake = "";
      const up = await upstream((body) => {
        fake ||= JSON.parse(body).messages[0].content;
        return toolUseStream("t1", "Grep", { pattern: fake, ...where });
      }, "text/event-stream");
      const running = await startProxy(
        claudeProfile({
          cwd: "/",
          env: { ANTHROPIC_BASE_URL: up.url },
          protectedPaths: [join(paths.stateDir, "**")],
        }),
        {
          configPaths: [paths.configPath],
          stateDir: paths.stateDir,
          env: {},
          notify: () => undefined,
          port: 0,
          token: "test-token",
        },
      );
      closers.push(() => running.close());

      const reply = await post(
        `${running.url}/v1/messages`,
        JSON.stringify({ messages: [{ role: "user", content: SECRET }] }),
      );

      expect(streamedInput(await reply.text())).toEqual({
        pattern: restored ? SECRET : fake,
        ...where,
      });
    },
  );

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
    const first = await proxy(up.url, paths);

    const reply = await post(
      `${first.url}/v1/messages`,
      JSON.stringify({
        messages: [{ role: "user", content: "password=Sun5et" }],
      }),
    );
    const restored = { command: "echo Sun5et" };
    expect(streamedInput(await reply.text())).toEqual(restored);
    for (const result of [undefined, "Sun5et\n"]) {
      const res = await post(
        `${first.url}/v1/messages`,
        history(restored, result),
      );
      await res.text();
    }
    await first.close();
    const second = await proxy(up.url, paths);
    const resumed = await post(
      `${second.url}/v1/messages`,
      history(restored, "Sun5et\n"),
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

  it("gives every run on the machine the same fakes, so a resumed or forked session keeps its history", async () => {
    const up = await upstream();
    const paths = dirs();
    const first = await proxy(up.url, paths);
    await post(`${first.url}/v1/messages`, payload);
    await first.close();

    const second = await proxy(up.url, paths);
    await post(`${second.url}/v1/messages`, payload);

    const [run1, run2] = up.received.map((r) => r.body);
    expect(run1).not.toContain(SECRET);
    expect(run2).toBe(run1);
  });

  it.each(["text/event-stream", "Text/Event-Stream; charset=utf-8"])(
    "gives the agent a streamed text reply with the reals back, as %s",
    async (contentType) => {
      const up = await upstream((body) => {
        const text = JSON.parse(body).messages[0].content;
        const events = [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
          { type: "content_block_stop", index: 0 },
        ];
        return events
          .map(
            (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join("");
      }, contentType);
      const { url } = await proxy(up.url);

      const reply = await (await post(`${url}/v1/messages`, payload)).text();

      expect(up.received[0].body).not.toContain(SECRET);
      expect(reply).toContain(SECRET);
    },
  );

  it("cuts a streamed reply whose event name is not its data type, logs why and sends it once", async () => {
    const start = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };
    const up = await upstream(
      `event: ping\ndata: ${JSON.stringify(start)}\n\n`,
      "text/event-stream",
    );
    const notices: string[] = [];
    const { url } = await proxy(up.url, dirs(), (message) =>
      notices.push(message),
    );

    const reply = post(`${url}/v1/messages`, payload).then((res) => res.text());

    await expect(reply).rejects.toThrow();
    expect(notices.join("\n")).toContain("STREAM_INVALID");
    expect(up.received).toHaveLength(1);
  });

  it("cuts a streamed reply whose tool call it cannot save, and logs why", async () => {
    const paths = dirs();
    const up = await upstream((body) => {
      const fake = JSON.parse(body).messages[0].content.slice("ticket ".length);
      appendFileSync(join(paths.stateDir, "vault.jsonl"), "{not json}\n");
      return toolUseStream("t1", "Bash", { command: `echo ${fake}` });
    }, "text/event-stream");
    const notices: string[] = [];
    const { url } = await proxy(up.url, paths, (message) =>
      notices.push(message),
    );

    const reply = post(`${url}/v1/messages`, payload).then((res) => res.text());

    await expect(reply).rejects.toThrow();
    expect(notices.join("\n")).toContain("STORE_CORRUPT");
  });
});
