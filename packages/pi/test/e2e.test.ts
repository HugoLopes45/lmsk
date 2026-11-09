import { existsSync, readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { request } from "node:http";
import { once } from "node:events";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { isRecord, loadVaultStore } from "@hugolopes45/lmsk-core";
import {
  fakeProvider,
  harness,
  type FakeProvider,
  type Harness,
  type HarnessOptions,
} from "./harness.ts";

const providers: FakeProvider[] = [];
const REQUEST_TIMEOUT_MS = 2000;

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

async function provider() {
  const result = await fakeProvider();
  providers.push(result);
  return result;
}

describe("localhost failure injection", () => {
  it("counts concurrent unfinished uploads against the aggregate capture budget", async () => {
    const p = await fakeProvider({ requestBytes: 16, captureBytes: 64 });
    const uploads = Array.from({ length: 5 }, () =>
      request(p.url, { method: "POST", headers: { "content-length": 1000 } }),
    );
    const errors: Error[] = [];
    for (const upload of uploads)
      upload.on("error", (error) => {
        errors.push(error);
      });
    const closed = uploads.map(
      (upload) =>
        new Promise<void>((resolve) => {
          upload.once("close", resolve);
        }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.all(
        uploads.map(async (upload) => {
          upload.end("x".repeat(16));
          await once(upload, "finish");
        }),
      );
      const fifth = closed[4];
      const outcome = await Promise.race([
        fifth.then(() => "rejected"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("accepted"), 1000);
        }),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      clearTimeout(timer);
      for (const upload of uploads) upload.destroy();
      await Promise.all(closed);
      await expect(p.close()).rejects.toThrow("capture");
    }
    expect(errors.length > 0).toBe(true);
  });
  it("retains incomplete upload bytes and rejects uncertain capture", async () => {
    const p = await fakeProvider();
    const partial = request(p.url, {
      method: "POST",
      headers: { "content-length": 1000 },
    });
    const faults: Error[] = [];
    partial.on("error", (error) => {
      faults.push(error);
    });
    const closed = new Promise<void>((resolve) => {
      partial.once("close", resolve);
    });
    try {
      partial.end("partial-upload-canary");
      await once(partial, "finish");
      const completed = await fetch(p.url, {
        method: "POST",
        body: "complete",
      });
      await completed.text();
      expect(
        p.bodies.some((body) => body.includes("partial-upload-canary")),
      ).toBe(true);
    } finally {
      partial.destroy();
      await closed;
      await expect(p.close()).rejects.toThrow("capture");
    }
    expect(faults.length).toBe(1);
  });
  it("rejects overlapping harness lifetimes without changing the owner environment", async () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    const first = await harness({ extensions: [] });
    const second = await harness({ extensions: [] }).then(
      (h) => ({ h, rejected: false }),
      () => ({ h: undefined, rejected: true }),
    );
    try {
      expect(second.rejected).toBe(true);
      expect(process.env.PI_CODING_AGENT_DIR === first.agentDir).toBe(true);
    } finally {
      await first.dispose();
      await second.h?.dispose();
    }
    expect(process.env.PI_CODING_AGENT_DIR === before).toBe(true);
  });

  it("rejects another harness while extension initialization is pending", async () => {
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = harness({
      extensions: [
        async () => {
          entered();
          await gate;
        },
      ],
    });
    try {
      await started;
      await expect(harness({ extensions: [] })).rejects.toThrow("Overlapping");
    } finally {
      release();
      await (await pending).dispose();
    }
  });

  it("bounds pending shutdown and still closes resources and restores the environment", async () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      extensions: [
        (pi) => {
          pi.on("session_shutdown", () => gate);
        },
      ],
    });
    const pending = h.dispose().then(
      () => "resolved",
      () => "rejected",
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("hung"), 2000);
    });
    try {
      expect(await Promise.race([pending, watchdog])).toBe("rejected");
      expect(process.env.PI_CODING_AGENT_DIR === before).toBe(true);
      await expect(fetch(h.provider.url)).rejects.toThrow();
    } finally {
      clearTimeout(timer);
      release();
      await pending;
    }
  });
  it("returns a scripted provider error while retaining the request for leak checks", async () => {
    const p = await provider();
    p.replies.push({ error: 503 });
    const response = await fetch(p.url, {
      method: "POST",
      body: "synthetic-canary",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(response.status).toBe(503);
    expect(p.bodies.length).toBe(1);
    expect(p.bodies[0] === "synthetic-canary").toBe(true);
  });

  it("closes sockets when a provider aborts before sending headers", async () => {
    const p = await provider();
    p.replies.push({ disconnect: true });
    await expect(
      fetch(p.url, {
        method: "POST",
        body: "synthetic-canary",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ).rejects.toThrow();
    expect(p.bodies.length).toBe(1);
  });

  it("tears down a delayed response without waiting for its timer", async () => {
    const p = await provider();
    p.replies.push({ text: "delayed", delayMs: 60000 });
    const pending = fetch(p.url, {
      method: "POST",
      body: "synthetic-canary",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rejected = expect(pending).rejects.toThrow();
    await p.waitForRequests(1);
    await p.close();
    await rejected;
  });

  it("runs extension shutdown once during overlapping teardown calls", async () => {
    let shutdowns = 0;
    const h = await harness({
      extensions: [
        (pi) => {
          pi.on("session_shutdown", () => {
            shutdowns += 1;
          });
        },
      ],
    });
    await Promise.all([h.dispose(), h.dispose()]);
    expect(shutdowns).toBe(1);
  });

  it("restores the agent directory after extension initialization fails", async () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    await expect(
      harness({
        extensions: [
          () => {
            throw new Error("Injected initialization failure");
          },
        ],
      }),
    ).rejects.toThrow("Extension loading failed");
    expect(process.env.PI_CODING_AGENT_DIR === before).toBe(true);
  });

  it("rejects generated fixture paths that escape the temporary project", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (depth) => {
        const path = `${"../".repeat(depth)}outside.txt`;
        await expect(
          harness({ extensions: [], files: { [path]: "fixture" } }),
        ).rejects.toThrow("Fixture path escapes");
      }),
      { seed: 321855, numRuns: 4 },
    );
  });
});

const sessions: Harness[] = [];
const CANARY = ["SYNTHETIC", "PRIVATE", "731942"].join("");
const INTEGRATION_TIMEOUT_MS = 15000;
/** The production entrypoint of this checkout. `LMSK_E2E_ENTRYPOINT` replaces it for a frozen snapshot. */
const entrypoint =
  process.env.LMSK_E2E_ENTRYPOINT ??
  fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const PROPERTY_SEED = 321854;
const PROPERTY_RUNS = 5;
const READ_MARKER = "READ_RESULT_VISIBLE";
const SECOND = ["SYNTHETIC", "SECOND", "408265"].join("");
const TOOL_CANARY = ["SYNTHETIC", "TOOL", "550117"].join("");
const USER_CANARY = ["SYNTHETIC", "USER", "660228"].join("");
const ASSISTANT_CANARY = ["SYNTHETIC", "ASSISTANT", "770339"].join("");

function configuration(value: string, strategy = "shape"): string {
  return JSON.stringify({
    rules: [{ id: "e2e-canary", type: "literal", values: [value], strategy }],
  });
}

async function integration(options: Partial<HarnessOptions> = {}) {
  const h = await harness({
    extensions: [],
    globalConfig: configuration(CANARY),
    ...options,
    entrypoint,
  });
  sessions.push(h);
  return h;
}

/**
 * The fake that the external store holds for a real value, read through the store
 * references on the active branch. Other branches are not reachable from the session.
 */
function learnedFake(h: Harness, real: string): string {
  let referenced = false;
  for (const entry of h.session.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "lmsk/vault")
      continue;
    referenced = true;
    if (!isRecord(entry.data) || typeof entry.data.namespaceId !== "string")
      throw new Error("Invalid persisted store reference");
    const store = loadVaultStore(
      join(h.agentDir, "lmsk-vaults"),
      entry.data.namespaceId,
    );
    for (const [stored, fake] of store.entries)
      if (stored === real) return fake;
  }
  if (!referenced) throw new Error("Active branch holds no store reference");
  throw new Error("Expected learned fake was not stored");
}

function assertMasked(h: Harness, value = CANARY): void {
  expect(h.provider.bodies.length > 0).toBe(true);
  // Boolean assertions keep captured bodies and canaries out of failure logs.
  expect(h.provider.bodies.every((body) => !body.includes(value))).toBe(true);
}

async function assertCliCapture(
  h: Harness,
  finished: Promise<boolean>,
  marker: string,
): Promise<void> {
  expect(await finished, "CLI must exit before the timeout").toBe(true);
  expect(h.provider.bodies.some((body) => body.includes(marker))).toBe(true);
  assertMasked(h);
}

function assertReadDelivery(h: Harness): void {
  expect(h.provider.bodies.length >= 2).toBe(true);
  expect(
    h.session.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "read" &&
          !entry.message.isError,
      ),
  ).toBe(true);
  expect(h.provider.bodies.some((body) => body.includes(READ_MARKER))).toBe(
    true,
  );
  assertMasked(h);
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((h) => h.dispose()));
});

describe("supplied extension wire integration", () => {
  beforeAll(() => {
    if (!isAbsolute(entrypoint) || !existsSync(entrypoint))
      throw new Error(
        `INTEGRATION_BLOCKED: extension entrypoint is missing or not absolute: ${entrypoint}`,
      );
  });

  it(
    "masks generated canaries in prompts",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[A-Z]{12}[0-9]{6}$/),
          async (value) => {
            const h = await integration({ globalConfig: configuration(value) });
            try {
              await h.session.prompt(
                `Preserve this opaque identifier: ${value}`,
              );
              assertMasked(h, value);
            } finally {
              await h.dispose();
            }
          },
        ),
        { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects a late leaking body even when the CLI completion succeeds",
    async () => {
      const h = await integration();
      const marker = "SAFE_FIRST_REQUEST";
      const first = await fetch(h.provider.url, {
        method: "POST",
        body: marker,
      });
      await first.text();
      const finished = new Promise<boolean>((resolve, reject) => {
        setTimeout(() => {
          fetch(h.provider.url, { method: "POST", body: CANARY })
            .then((response) => response.text())
            .then(() => resolve(true), reject);
        }, 0);
      });
      await expect(assertCliCapture(h, finished, marker)).rejects.toThrow();
      await finished;
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "owns a pending CLI child through harness disposal",
    async () => {
      const h = await integration({
        files: {
          "hold.mjs":
            'export default pi => { process.on("SIGTERM", () => {}); pi.on("session_shutdown", () => new Promise(() => {})); };',
        },
      });
      const finished = h
        .print(["-e", join(h.cwd, "hold.mjs"), "Wait at shutdown"])
        .then(
          () => "resolved",
          () => "rejected",
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await h.provider.waitForRequests(1);
        await h.dispose();
        const outcome = await Promise.race([
          finished,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("alive"), 500);
          }),
        ]);
        expect(outcome).toBe("rejected");
      } finally {
        clearTimeout(timer);
        await finished;
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "expands a real CLI file argument and masks its attachment bytes",
    async () => {
      const marker = "FILE_ATTACHMENT_VISIBLE";
      const h = await integration({
        files: { "attached.txt": `${marker} ${CANARY}` },
      });
      const finished = h
        .print(["@attached.txt", "Describe the attachment"])
        .then(
          () => true,
          () => false,
        );
      await assertCliCapture(h, finished, marker);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "masks file references and read tool results",
    async () => {
      const h = await integration({
        files: { "fixture.txt": `${READ_MARKER} ${CANARY}` },
      });
      h.provider.replies.push({ tool: "read", args: { path: "fixture.txt" } });
      await h.session.prompt(
        "Inspect @fixture.txt, then read fixture.txt again",
      );
      assertReadDelivery(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "sends neither case of a learned account id that a later tool prints lowercased",
    async () => {
      const h = await integration({
        globalConfig: "{}",
        files: {
          "facts.txt": "account TE1234567",
          "test.log": "branch feature/te1234567-fix",
        },
      });
      h.provider.replies.push(
        { tool: "read", args: { path: "facts.txt" } },
        { tool: "read", args: { path: "test.log" } },
      );
      await h.session.prompt("Read facts.txt, then test.log");
      expect(h.provider.bodies.length).toBe(3);
      expect(h.sent().includes("branch feature/")).toBe(true);
      expect(h.sent().toLowerCase().includes("te1234567")).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects a blocked read as evidence of successful result masking",
    async () => {
      const h = await integration({
        files: { "fixture.txt": `${READ_MARKER} ${CANARY}` },
        extensions: [
          (pi) => {
            pi.on("tool_call", (event) => {
              if (event.toolName === "read")
                return { block: true, reason: "Injected read denial" };
            });
          },
        ],
      });
      h.provider.replies.push({ tool: "read", args: { path: "fixture.txt" } });
      await h.session.prompt("Read fixture.txt");
      expect(() => assertReadDelivery(h)).toThrow();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "restores real values into bash and keeps its output masked",
    async () => {
      const h = await integration();
      await h.session.prompt(`Keep ${CANARY}`);
      const fake = learnedFake(h, CANARY);
      h.provider.replies.push(
        {
          tool: "bash",
          args: { command: `printf '%s' '${fake}' > bash-result.txt` },
        },
        {
          tool: "bash",
          args: { command: `printf '%s' '${fake}' | base64` },
        },
      );
      await h.session.prompt("Run the planned local commands");
      expect(
        readFileSync(join(h.cwd, "bash-result.txt"), "utf8") === CANARY,
      ).toBe(true);
      const persisted = JSON.stringify(h.session.sessionManager.getEntries());
      expect(persisted.includes(CANARY)).toBe(false);
      expect(persisted.includes(Buffer.from(CANARY).toString("base64"))).toBe(
        false,
      );
      expect(
        h.provider.bodies.some((body) =>
          body.includes(Buffer.from(CANARY).toString("base64")),
        ),
      ).toBe(false);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "restores written file content",
    async () => {
      const h = await integration();
      await h.session.prompt(`Keep ${CANARY}`);
      const fake = learnedFake(h, CANARY);
      h.provider.replies.push({
        tool: "write",
        args: { path: "written.txt", content: fake },
      });
      await h.session.prompt("Run the planned local write");
      expect(readFileSync(join(h.cwd, "written.txt"), "utf8") === CANARY).toBe(
        true,
      );
      h.provider.replies.push({
        tool: "edit",
        args: {
          path: "written.txt",
          oldText: fake,
          newText: `updated ${fake}`,
        },
      });
      await h.session.prompt("Apply the planned local edit");
      expect(
        readFileSync(join(h.cwd, "written.txt"), "utf8") ===
          `updated ${CANARY}`,
      ).toBe(true);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "keeps real values out of every persisted session entry",
    async () => {
      const h = await integration({
        files: { "source.txt": `Source value ${CANARY}` },
      });
      h.provider.replies.push(
        { tool: "read", args: { path: "source.txt" } },
        { text: `Assistant echoes ${CANARY}` },
      );
      await h.session.prompt(`Keep ${CANARY}`);
      const persisted = JSON.stringify(h.session.sessionManager.getEntries());
      expect(persisted.includes(CANARY)).toBe(false);
      expect(persisted.includes("Assistant echoes")).toBe(true);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "keeps real values out of the custom session entries",
    async () => {
      const h = await integration();
      await h.session.prompt(`Keep ${CANARY}`);
      const custom = h.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom");
      expect(learnedFake(h, CANARY).length > 0).toBe(true);
      expect(JSON.stringify(custom).includes(CANARY)).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "keeps real values of every role out of the session file bytes, including a failed provider attempt",
    async () => {
      const h = await integration({
        persist: true,
        files: { "source.txt": `Source value ${TOOL_CANARY}` },
        globalConfig: JSON.stringify({
          rules: [
            {
              id: "e2e-canary",
              type: "literal",
              values: [CANARY, TOOL_CANARY, USER_CANARY, ASSISTANT_CANARY],
            },
            {
              id: "e2e-retry-status",
              type: "literal",
              values: ["503"],
              strategy: "fixed",
              replacement: "400-{n}",
            },
          ],
        }),
      });
      h.provider.replies.push(
        { tool: "read", args: { path: "source.txt" } },
        { text: `Assistant echoes ${ASSISTANT_CANARY}` },
        { error: 503, message: `upstream rejected ${CANARY}` },
      );
      await h.session.prompt(`Keep ${USER_CANARY}`);
      await h.session.prompt(`Retry ${USER_CANARY}`);
      const file = h.session.sessionManager.getSessionFile();
      if (file === undefined) throw new Error("Session is not file-backed");
      const bytes = readFileSync(file, "utf8");
      expect(bytes.includes('"role":"user"')).toBe(true);
      expect(bytes.includes('"role":"toolResult"')).toBe(true);
      expect(bytes.includes('"role":"assistant"')).toBe(true);
      expect(bytes.includes('"stopReason":"error"')).toBe(true);
      expect(
        bytes.includes('"errorMessage":"503 provider error, text withheld"'),
      ).toBe(true);
      expect(bytes.includes("Assistant echoes")).toBe(true);
      for (const canary of [CANARY, TOOL_CANARY, USER_CANARY, ASSISTANT_CANARY])
        expect(bytes.includes(canary)).toBe(false);
      assertMasked(h, TOOL_CANARY);
      assertMasked(h, USER_CANARY);
      assertMasked(h, ASSISTANT_CANARY);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "blocks invalid configuration without sending a body",
    async () => {
      const h = await integration({ globalConfig: "{" });
      await h.session.prompt(CANARY);
      expect(h.provider.bodies.length).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  // Each persisted message waits out one scan timeout: the system, user and aborted assistant messages.
  it(
    "blocks a scanner timeout when worker delivery is lost",
    async () => {
      const h = await integration({
        globalConfig: JSON.stringify({
          rules: [{ id: "e2e-canary", type: "literal", values: [CANARY] }],
          scanTimeoutMs: 200,
        }),
      });
      const delivery = vi
        .spyOn(Worker.prototype, "postMessage")
        .mockImplementation(() => undefined);
      try {
        await h.session.prompt(CANARY);
        expect(delivery.mock.calls.length > 0).toBe(true);
        expect(h.provider.bodies.length).toBe(0);
      } finally {
        delivery.mockRestore();
      }
    },
    3 * INTEGRATION_TIMEOUT_MS,
  );

  it(
    "blocks a matching block rule without sending a body",
    async () => {
      const h = await integration({
        globalConfig: configuration(CANARY, "block"),
      });
      await h.session.prompt(CANARY);
      expect(h.provider.bodies.length).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "does not send a concurrent unqueued prompt while the first request is pending",
    async () => {
      const h = await integration();
      h.provider.replies.push({ text: "delayed", delayMs: 50 });
      const first = h.session.prompt(CANARY);
      await h.provider.waitForRequests(1);
      await expect(h.session.prompt(`second ${CANARY}`)).rejects.toThrow();
      await first;
      expect(h.provider.bodies.length).toBe(1);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "checks protected fixture paths after restoring the fake path",
    async () => {
      const path = "blocked-fixture.txt";
      const reads: { isError: boolean; durationMs: number | undefined }[] = [];
      const h = await integration({
        globalConfig: JSON.stringify({
          rules: [
            { id: "e2e-canary", type: "literal", values: [path, CANARY] },
          ],
          protectedPaths: [`**/${path}`],
        }),
        files: { [path]: CANARY },
        extensions: [
          (pi) => {
            pi.on("tool_execution_end", (event) => {
              if (event.toolName === "read")
                reads.push({
                  isError: event.isError,
                  durationMs: event.durationMs,
                });
            });
          },
        ],
      });
      await h.session.prompt(`Remember ${path}`);
      h.provider.replies.push({
        tool: "read",
        args: { path: learnedFake(h, path) },
      });
      await h.session.prompt("Try the planned file read");
      expect(reads).toEqual([{ isError: true, durationMs: undefined }]);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "blocks a trusted project attempting to disable the global rule",
    async () => {
      const h = await integration({
        trusted: true,
        files: {
          ".pi/lmsk.json": JSON.stringify({
            rules: [{ id: "e2e-canary", enabled: false }],
          }),
        },
      });
      await h.session.prompt(CANARY);
      expect(h.provider.bodies.length).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "masks the request even when a later hook throws",
    async () => {
      const h = await integration({
        extensions: [
          (pi) => {
            pi.on("before_provider_request", () => {
              throw new Error("Injected hook failure");
            });
          },
        ],
      });
      await h.session.prompt(CANARY);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "does not resend plaintext after provider failure",
    async () => {
      const h = await integration({ retry: true });
      const recovery = "RECOVERY_CONFIRMED";
      h.provider.replies.push({ error: 503 }, { text: recovery });
      await h.session.prompt(CANARY);
      expect(h.provider.bodies.length).toBe(2);
      expect(
        h.session.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              entry.message.stopReason === "stop" &&
              entry.message.content.some(
                (block) =>
                  block.type === "text" && block.text.includes(recovery),
              ),
          ),
      ).toBe(true);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "blocks an oversized payload before any request",
    async () => {
      const h = await integration();
      const oversizedBytes = 9 * 1024 * 1024;
      await h.session.prompt(`${CANARY} ${"x".repeat(oversizedBytes)}`);
      expect(h.provider.bodies.length).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "masks abandoned branch history without depending on compaction",
    async () => {
      const h = await integration();
      for (const suffix of ["one", "two", "three"])
        h.session.sessionManager.appendMessage({
          role: "user",
          content: `${CANARY} ${suffix}`,
          timestamp: 0,
        });
      const first = h.session.sessionManager
        .getEntries()
        .find((e) => e.type === "message");
      if (!first) throw new Error("Missing history fixture");
      const result = await h.session.navigateTree(first.id, {
        summarize: true,
        customInstructions: CANARY,
      });
      expect(result.cancelled).toBe(false);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "keeps a mapping learned after tree navigation reachable from the active branch",
    async () => {
      const h = await integration({
        globalConfig: JSON.stringify({
          rules: [
            {
              id: "e2e-canary",
              type: "literal",
              values: [CANARY, SECOND],
              strategy: "shape",
            },
          ],
        }),
      });
      h.session.sessionManager.appendMessage({
        role: "user",
        content: "root",
        timestamp: 0,
      });
      const root = h.session.sessionManager.getLeafId();
      if (!root) throw new Error("Missing root entry");
      await h.session.prompt(`Keep ${CANARY}`);
      const result = await h.session.navigateTree(root, { summarize: false });
      expect(result.cancelled).toBe(false);
      await h.session.prompt(`Keep ${SECOND}`);
      expect(h.sent()).not.toContain(SECOND);
      expect(learnedFake(h, CANARY).length > 0).toBe(true);
      expect(learnedFake(h, SECOND).length > 0).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "masks compaction and tree-summary instructions on the wire",
    async () => {
      const h = await integration();
      for (const suffix of ["one", "two", "three", "four"])
        h.session.sessionManager.appendMessage({
          role: "user",
          content: `${CANARY} ${suffix}`,
          timestamp: 0,
        });
      await h.session.compact(CANARY);
      assertMasked(h);
      const first = h.session.sessionManager
        .getEntries()
        .find((entry) => entry.type === "message");
      if (!first) throw new Error("Missing local history");
      const before = h.provider.bodies.length;
      const result = await h.session.navigateTree(first.id, {
        summarize: true,
        customInstructions: CANARY,
      });
      expect(result.cancelled).toBe(false);
      expect(h.provider.bodies.length > before).toBe(true);
      assertMasked(h);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it.each(["", " 4000"])(
    "masks adjacent card numbers on the wire and in the session, CVV=%j",
    async (code) => {
      const h = await integration({ globalConfig: undefined });
      const first = `5156 3777 8930 3107${code}`;
      const second = "4000 4000 0000 0000 002";
      await h.session.prompt(`card=${first} ${second}`);
      const fakes = [learnedFake(h, first), learnedFake(h, second)];
      expect(h.sent().includes(`card=${fakes.join(" ")}`)).toBe(true);
      assertMasked(h, first);
      assertMasked(h, second);
      assertMasked(h, "4000 0000 0000 002");
      const session = JSON.stringify(h.session.sessionManager.getEntries());
      expect(session.includes(first) || session.includes(second)).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
