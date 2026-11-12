import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Guard, type HostContext, type ToolCall } from "../../src/core/guard.ts";
import { Masker } from "../../src/core/masker.ts";
import type { OpenOptions, VaultReference } from "../../src/core/session.ts";

const REAL = "Kx91abQuillHarbor";
/** Too short to learn on its own: only a restore makes the result mask it. */
const SHORT = "hunterz";
const STORE_PATH = "/srv/host-store/key.json";
const PATHS = {
  rules: [
    { id: "lit", type: "literal", values: [REAL, STORE_PATH] },
    {
      id: "password",
      type: "keyed",
      strategy: "shape",
      keys: ["password"],
      value: "[A-Za-z0-9]{7}",
    },
  ],
};

/** A call whose path is read after the restore, as a host reads it from the event. */
function call(
  id: string,
  tool: string,
  input: Record<string, unknown>,
): ToolCall {
  return {
    id,
    tool,
    input,
    verified: true,
    cwd: "/",
    path: () => (typeof input.path === "string" ? input.path : undefined),
  };
}

/** The fake of SHORT, learned from a keyed value. */
async function shortFake(guard: Guard): Promise<string> {
  const masked = await guard.maskText(`password=${SHORT}`);
  return masked.slice("password=".length);
}

interface Harness {
  guard: Guard;
  ctx: HostContext & { notices: string[]; aborts: number };
  references: VaultReference[];
  /** Makes the host's reference records throw on read. */
  breakRead(): void;
  /** Makes the host's reference records throw on append. */
  breakAppend(): void;
  /** The text of every store file. */
  stores(): string[];
  open(
    config?: unknown,
    host?: Partial<Pick<OpenOptions, "env" | "defaultRules">>,
  ): void;
}

const guards: Guard[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const guard of guards.splice(0)) guard.close();
});

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const references: VaultReference[] = [];
  let readBroken = false;
  let appendBroken = false;
  const guard = new Guard({
    name: "host-guard",
    tools: ["shell", "read"],
    protectedPaths: ["**/host-store/**"],
    format: { opaque: () => false },
  });
  guards.push(guard);
  const ctx = {
    notices: [] as string[],
    aborts: 0,
    ui: {
      notify: (message: string) => {
        ctx.notices.push(message);
      },
    },
    abort: () => {
      ctx.aborts += 1;
    },
  };
  const open = (
    config: unknown = {
      rules: [{ id: "lit", type: "literal", values: [REAL] }],
    },
    host: Partial<Pick<OpenOptions, "env" | "defaultRules">> = {},
  ): void => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    guard.open(
      () => ({
        configPaths: [path],
        projectConfigPath: undefined,
        storeDir: join(dir, "stores"),
        references: {
          read: () => {
            if (readBroken) throw new Error("records gone");
            return references;
          },
          append: (reference) => {
            if (appendBroken) throw new Error("disk full");
            references.push(reference);
          },
        },
        env: {},
        defaultRules: [],
        ...host,
      }),
      ctx,
    );
  };
  const breakRead = (): void => {
    readBroken = true;
  };
  const breakAppend = (): void => {
    appendBroken = true;
  };
  const stores = (): string[] => {
    const storeDir = join(dir, "stores");
    return readdirSync(storeDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(join(storeDir, name), "utf8"));
  };
  return { guard, ctx, references, breakRead, breakAppend, stores, open };
}

describe("Guard", () => {
  it("masks text, saves the mapping and publishes one reference without a host SDK", async () => {
    const { guard, references, open } = harness();
    open();
    const masked = await guard.maskText(`key ${REAL}`);
    expect(masked).not.toContain(REAL);
    await guard.maskText(`again ${REAL}`);
    expect(references).toHaveLength(1);
  });

  it("blocks on an invalid configuration and reports it once with the host name", async () => {
    const { guard, ctx, open } = harness();
    open({ unknown: 1 });
    await expect(guard.maskText("x")).rejects.toThrow("CONFIG_INVALID");
    guard.report(ctx, "OTHER");
    expect(ctx.notices).toEqual([
      "host-guard: CONFIG_INVALID. Requests that need masking are blocked.",
    ]);
  });

  it("shows one stop notice per session and still shows a later block", async () => {
    const { guard, ctx, open, references } = harness();
    open();
    guard.report(ctx, "SCAN_TIMEOUT");
    guard.report(ctx, "SCAN_TIMEOUT");
    references.push({ namespaceId: "0".repeat(32) });
    guard.attachReferences(ctx);
    expect(ctx.notices).toEqual([
      "host-guard: SCAN_TIMEOUT. The request was stopped. Masking stays on.",
      "host-guard: STORE_REFERENCE_CONFLICT. Requests that need masking are blocked.",
    ]);
  });

  it("returns the fail result with the code when the session is blocked", async () => {
    const { guard, ctx } = harness();
    const result = await guard.guarded(
      ctx,
      (_ctx, code) => code,
      async () => "ran",
    );
    expect(result).toBe("NOT_STARTED");
  });

  it("returns the fail result with the code of a throw", async () => {
    const { guard, ctx, open } = harness();
    open();
    const result = await guard.guarded(
      ctx,
      (_ctx, code) => code,
      () => guard.maskPayload({ self: undefined, fn: () => 1 }),
    );
    expect(result).toBe("PAYLOAD_SHAPE");
  });

  it("masks texts in input order and rejects with the code when the session is blocked", async () => {
    const { guard, open } = harness();
    await expect(guard.maskTexts(["x"])).rejects.toMatchObject({
      code: "NOT_STARTED",
    });
    open();
    const masked = await guard.maskTexts(["plain", `key ${REAL}`, "end"]);
    expect(masked[0]).toBe("plain");
    expect(masked[1]).toMatch(/^key /);
    expect(masked[1]).not.toContain(REAL);
    expect(masked[2]).toBe("end");
  });

  it("refuses a hidden real only when asked, with the configured readings", async () => {
    const { guard, open } = harness();
    open({
      rules: [{ id: "pw", type: "literal", values: ["Huntr3ss-Fake-9wP"] }],
    });
    await guard.maskText("Huntr3ss-Fake-9wP");
    const reversed = ["Pw9-ekaF-ss3rtnuH"];
    await expect(guard.maskTexts(reversed)).resolves.toHaveLength(1);
    await expect(
      guard.maskTexts(reversed, { refuseHidden: "plain" }),
    ).resolves.toHaveLength(1);
    await expect(
      guard.maskTexts(reversed, { refuseHidden: "configured" }),
    ).rejects.toMatchObject({ code: "HIDDEN_REAL" });
  });

  it("masks a payload and passes it unchanged while masking is off", async () => {
    const { guard, open } = harness();
    open();
    const masked = await guard.maskPayload({ content: REAL });
    expect(JSON.stringify(masked)).not.toContain(REAL);
    guard.setRedaction("off");
    const raw = { content: REAL };
    expect(await guard.maskPayload(raw)).toBe(raw);
  });

  it("fails a bound payload mask once another session opens", async () => {
    const { guard, open, references } = harness();
    open();
    const masker = guard.payloadMasker();
    open();
    await expect(masker.maskPayload({ content: REAL })).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(references).toEqual([]);
  });

  it("runs masks one at a time", async () => {
    const { guard, open } = harness();
    open();
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mask = Masker.prototype.mask;
    // The test seam: holds the first mask open to show that the second waits for it.
    vi.spyOn(Masker.prototype, "mask").mockImplementation(async function (
      this: Masker,
      texts,
      restored,
    ) {
      order.push(`${texts[0]} start`);
      if (texts[0] === "first") await gate;
      const masked = await mask.call(this, texts, restored);
      order.push(`${texts[0]} end`);
      return masked;
    });
    const first = guard.maskTexts(["first"]);
    const second = guard.maskTexts(["second"]);
    await vi.waitFor(() => expect(order).toEqual(["first start"]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first start",
      "first end",
      "second start",
      "second end",
    ]);
  });

  it("passes text unchanged while masking is off and reports the status", async () => {
    const { guard, open } = harness();
    open();
    expect(guard.status()).toBe(
      "host-guard: enabled. Entries written while off stay raw.",
    );
    expect(guard.setRedaction("off")).toMatch(/^host-guard: off\./);
    expect(await guard.maskText(REAL)).toBe(REAL);
    expect(guard.status()).toMatch(/^host-guard: off\./);
    expect(guard.setRedaction("enabled")).toMatch(/^host-guard: enabled\./);
    expect(await guard.maskText(REAL)).not.toBe(REAL);
  });

  it("refuses to change masking or restore text while the session is blocked", () => {
    const { guard } = harness();
    expect(() => guard.setRedaction("off")).toThrow("NOT_STARTED");
    expect(() => guard.restoreText("x")).toThrow("NOT_STARTED");
    expect(guard.status()).toMatch(/^host-guard: blocked \(NOT_STARTED\)\./);
  });

  it("restores the real values of fakes in a text", async () => {
    const { guard, open } = harness();
    open();
    const masked = await guard.maskText(`key ${REAL}`);
    expect(guard.restoreText(masked)).toBe(`key ${REAL}`);
  });

  it("restores a verified tool input, and keeps fakes in a network command or an unverified tool", async () => {
    const { guard, open } = harness();
    open();
    const fake = await guard.maskText(REAL);
    const read = { path: fake };
    expect(guard.toolCall(call("c1", "read", read))).toEqual({
      blocked: false,
    });
    expect(read.path).toBe(REAL);
    const upload = { command: `curl -d ${fake} example.test` };
    guard.toolCall({ ...call("c2", "shell", upload), commandKey: "command" });
    expect(upload.command).toContain(fake);
    const unknown = { path: fake };
    guard.toolCall(call("c3", "unknown", unknown));
    expect(unknown.path).toBe(fake);
    const unverified = { path: fake };
    guard.toolCall({ ...call("c4", "read", unverified), verified: false });
    expect(unverified.path).toBe(fake);
  });

  it("blocks a fake path that restores into a protected path", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const fake = await guard.maskText(STORE_PATH);
    // Without the restore, the fake path passes the check.
    expect(
      guard.toolCall({
        ...call("c0", "read", { path: fake }),
        verified: false,
      }),
    ).toEqual({ blocked: false });
    expect(guard.toolCall(call("c1", "read", { path: fake }))).toEqual({
      blocked: true,
    });
  });

  it("masks a short restored real in the call's result without the host passing it", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.toolCall(call("c1", "read", { path: "a.txt", note: short }));
    expect(await guard.toolResult("other")([`saw ${SHORT}`])).toEqual([
      `saw ${SHORT}`,
    ]);
    const [masked] = await guard.toolResult("c1")([`saw ${SHORT}`]);
    expect(masked).not.toContain(SHORT);
  });

  it("remembers nothing for a blocked call", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    const path = await guard.maskText(STORE_PATH);
    expect(guard.toolCall(call("c1", "read", { path, note: short }))).toEqual({
      blocked: true,
    });
    expect(await guard.toolResult("c1")([`saw ${SHORT}`])).toEqual([
      `saw ${SHORT}`,
    ]);
  });

  it("takes the call's reals when the result starts, once", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.toolCall(call("c1", "read", { path: "a.txt", note: short }));
    // A result whose masking fails before it masks has used the reals too.
    guard.toolResult("c1");
    expect(await guard.toolResult("c1")([`saw ${SHORT}`])).toEqual([
      `saw ${SHORT}`,
    ]);
  });

  it("gives the call's reals to one of two results in the same tick", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.toolCall(call("c1", "read", { path: "a.txt", note: short }));
    const [first, second] = await Promise.all([
      guard.toolResult("c1")([`saw ${SHORT}`]),
      guard.toolResult("c1")([`saw ${SHORT}`]),
    ]);
    expect(first[0]).not.toContain(SHORT);
    expect(second).toEqual([`saw ${SHORT}`]);
  });

  it("forgets the reals of a call that ends without a result", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.toolCall(call("c1", "read", { path: "a.txt", note: short }));
    guard.toolEnd("c1");
    expect(await guard.toolResult("c1")([`saw ${SHORT}`])).toEqual([
      `saw ${SHORT}`,
    ]);
  });

  it("replays a call's restore and gives its reals without keeping them", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    const input = { path: "a.txt", note: short };
    expect(guard.restoredBy(call("c1", "read", input))).toEqual({
      blocked: false,
      reals: [SHORT],
    });
    expect(input.note).toBe(SHORT);
    expect(await guard.toolResult("c1")([`saw ${SHORT}`])).toEqual([
      `saw ${SHORT}`,
    ]);
    const path = await guard.maskText(STORE_PATH);
    expect(guard.restoredBy(call("c2", "read", { path, note: short }))).toEqual(
      { blocked: true, reals: [] },
    );
  });

  it("masks the given reals across a payload, also in a text masked before without them", async () => {
    const { guard, open } = harness();
    open(PATHS);
    await shortFake(guard);
    const payload = { text: `saw ${SHORT}` };
    expect(await guard.maskPayload(payload)).toEqual(payload);
    const masked = await guard.maskPayload(payload, [SHORT]);
    expect(JSON.stringify(masked)).not.toContain(SHORT);
  });

  it("protects the host's own files also when the session is blocked", () => {
    const { guard } = harness();
    const blocked = (path: string): boolean =>
      guard.toolCall(call("c1", "read", { path })).blocked;
    expect(blocked("/x/host-store/a.json")).toBe(true);
    expect(blocked("/x/.env")).toBe(true);
    expect(blocked("/x/readme.md")).toBe(false);
  });

  it("blocks when the host's records reference another store", async () => {
    const { guard, ctx, open, references } = harness();
    open();
    await guard.maskText(REAL);
    references.splice(0, references.length, { namespaceId: "0".repeat(32) });
    guard.attachReferences(ctx);
    await expect(guard.maskText("x")).rejects.toThrow(
      "STORE_REFERENCE_CONFLICT",
    );
  });

  it("blocks the session when the host's records cannot be read at open", async () => {
    const { guard, ctx, open, breakRead } = harness();
    breakRead();
    open();
    await expect(guard.maskText("x")).rejects.toThrow("UNEXPECTED_ERROR");
    expect(ctx.notices).toEqual([
      "host-guard: UNEXPECTED_ERROR. Requests that need masking are blocked.",
    ]);
  });

  it("blocks the session when the host's records cannot be read", async () => {
    const { guard, ctx, open, breakRead } = harness();
    open();
    breakRead();
    guard.attachReferences(ctx);
    await expect(guard.maskText("x")).rejects.toThrow("UNEXPECTED_ERROR");
  });

  it("writes no real to a store that no reference names", async () => {
    const { guard, open, breakAppend, stores } = harness();
    open();
    breakAppend();
    await expect(guard.maskText(`key ${REAL}`)).rejects.toThrow("disk full");
    for (const store of stores()) expect(store).not.toContain(REAL);
  });

  it("blocks the session when its open options throw", async () => {
    const { guard, ctx } = harness();
    guard.open(() => {
      throw new Error("unreadable");
    }, ctx);
    await expect(guard.maskText("x")).rejects.toThrow("UNEXPECTED_ERROR");
    expect(ctx.notices).toEqual([
      "host-guard: UNEXPECTED_ERROR. Requests that need masking are blocked.",
    ]);
  });

  it("learns env values from the open options, not from the process", async () => {
    const { guard, open } = harness();
    vi.stubEnv("HOST_GUARD_PROCESS", "Pr0cessOnlyValue77");
    open(
      {
        rules: [
          {
            id: "e",
            type: "env",
            vars: ["HOST_GUARD_TOKEN", "HOST_GUARD_PROCESS"],
          },
        ],
      },
      { env: { HOST_GUARD_TOKEN: "0ptionTokenValue42" } },
    );
    const masked = await guard.maskText(
      "a 0ptionTokenValue42 b Pr0cessOnlyValue77",
    );
    expect(masked).not.toContain("0ptionTokenValue42");
    expect(masked).toContain("Pr0cessOnlyValue77");
  });

  it("masks the host's default rules under the configuration", async () => {
    const { guard, open } = harness();
    open(
      {},
      {
        defaultRules: [
          {
            id: "host-id",
            type: "literal",
            enabled: true,
            strategy: "mask",
            values: ["Hostowner7Name"],
          },
        ],
      },
    );
    expect(await guard.maskText("by Hostowner7Name")).not.toContain(
      "Hostowner7Name",
    );
  });

  it("fails every mask after close", async () => {
    const { guard, open } = harness();
    open();
    guard.close();
    await expect(guard.maskText("x")).rejects.toThrow("SESSION_SHUTDOWN");
  });
});
