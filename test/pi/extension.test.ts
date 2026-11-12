import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  createReadTool,
  createSyntheticSourceInfo,
  type BeforeProviderRequestEvent,
  type MessageEndEvent,
  type ModelRegistry,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type ToolCallEvent,
  type ToolExecutionEndEvent,
  type ToolInfo,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ClassifierContext,
  ImagesContext,
  Model,
} from "@earendil-works/pi-ai";
import {
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lmsk from "../../src/pi/extension.ts";
import { installModelGuard } from "../../src/pi/guard-runtime.ts";
import type { BranchRecord } from "../../src/pi/host.ts";
import { loadVaultStore, Scanner } from "../../src/core/index.ts";

/** Fault hook at the fs boundary; unset hooks call the real functions. */
const faults = vi.hoisted(() => ({ directoryFlushFails: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (faults.directoryFlushFails && actual.fstatSync(fd).isDirectory())
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      return actual.fsyncSync(fd);
    },
  };
});

/** A made-up project codename that no default rule matches, so only a configured rule masks it. */
const CODENAME = "Quill-Harbor-Ninety";
/** The JSON of a string this long is over the 8 MiB payload limit: the quotes and keys add bytes. */
const PAYLOAD_LIMIT_TEXT_LENGTH = 8 * 1024 * 1024;
const OTHER = "Basalt-Lantern-Forty";
const VAULT_ENTRY = "lmsk/vault";
const VAULT_STORE_DIR = "lmsk-vaults";

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pms-hooks-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(projectDir, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "gitconfig"));
});

afterEach(() => {
  faults.directoryFlushFails = false;
  vi.unstubAllEnvs();
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeProjectConfig(): void {
  writeJson(join(projectDir, ".pi", "lmsk.json"), {
    rules: [{ id: "codename", type: "literal", values: [CODENAME] }],
  });
}

function writeGlobalConfig(value: unknown): void {
  writeJson(join(agentDir, "lmsk", "config.json"), value);
}

/** The namespace ID of a session reference. Throws on any other shape. */
function namespaceOf(data: unknown): string {
  if (
    typeof data !== "object" ||
    data === null ||
    !("namespaceId" in data) ||
    typeof data.namespaceId !== "string"
  )
    throw new Error("session entry is not a store reference");
  return data.namespaceId;
}

/** The mappings in the external store that a session reference names. */
function storeEntries(namespaceId: string) {
  return loadVaultStore(join(agentDir, VAULT_STORE_DIR), namespaceId).entries;
}

interface Notice {
  message: string;
  level: string | undefined;
}

interface TestContext {
  cwd: string;
  isProjectTrusted(): boolean;
  abort(): void;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager: {
    getBranch(): BranchRecord[];
  };
  model: { id: string; provider: string };
  modelRegistry: Pick<ModelRegistry, "classify" | "generateImages"> & {
    streamSimple: ProviderStub["streamSimple"];
  };
  aborts: number;
  notices: Notice[];
}

const GLUED_NOTICE = {
  message:
    "lmsk: HIDDEN_REAL. A secret glued to a word is in the conversation or a context file. Use /tree to go back before it without a summary, start a new session, or remove it from the context file.",
  level: "error",
};

/** Stands in for the provider stream: runs `onPayload` as the transport does, then answers. */
interface ProviderStub {
  /** Request bodies that reached the provider, after the masking hook ran. */
  bodies: unknown[];
  streamSimple(
    model: unknown,
    context: unknown,
    options: { onPayload?: (payload: unknown, model: unknown) => unknown },
  ): { result(): Promise<AssistantMessage> };
}

function providerStub(
  reply: { text: string; stopReason?: "stop" | "length" | "error" } = {
    text: "## Goal\nKeep going",
  },
): ProviderStub {
  const bodies: unknown[] = [];
  return {
    bodies,
    streamSimple: (model, context, options) => {
      const answer = (async (): Promise<AssistantMessage> => {
        const body = (await options.onPayload?.(context, model)) ?? context;
        bodies.push(body);
        return {
          ...assistantMessage([{ type: "text", text: reply.text }]),
          stopReason: reply.stopReason ?? "stop",
        };
      })();
      return { result: () => answer };
    },
  };
}

function testContext(
  options: {
    trusted?: boolean;
    branch?: BranchRecord[];
    cwd?: string;
    provider?: ProviderStub;
  } = {},
): TestContext {
  const provider = options.provider ?? providerStub();
  const ctx: TestContext = {
    cwd: options.cwd ?? projectDir,
    isProjectTrusted: () => options.trusted ?? true,
    abort: () => {
      ctx.aborts++;
    },
    ui: {
      notify: (message, level) => {
        ctx.notices.push({ message, level });
      },
    },
    sessionManager: { getBranch: () => options.branch ?? [] },
    model: { id: "summary-model", provider: "openai" },
    modelRegistry: {
      classify: vi.fn(),
      generateImages: vi.fn(),
      streamSimple: provider.streamSimple,
    },
    aborts: 0,
    notices: [],
  };
  return ctx;
}

type ToolSource = Pick<ToolInfo, "name" | "sourceInfo">;

/** Listed as pi lists core builtins: source `builtin`, path `builtin:<name>`. */
const BUILTIN_TOOLS: ToolSource[] = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
].map((name) => ({
  name,
  sourceInfo: createSyntheticSourceInfo(`builtin:${name}`, {
    source: "builtin",
  }),
}));

/** Hands the extension a fake pi that stores the handlers it registers. */
function fakePi(options: { appendFails?: boolean; tools?: ToolSource[] } = {}) {
  const handlers: {
    session_start?: (event: SessionStartEvent, ctx: TestContext) => unknown;
    before_provider_request?: (
      event: BeforeProviderRequestEvent,
      ctx: TestContext,
    ) => unknown;
    tool_call?: (event: ToolCallEvent, ctx: TestContext) => unknown;
    tool_result?: (event: ToolResultEvent, ctx: TestContext) => unknown;
    message_end?: (event: MessageEndEvent, ctx: TestContext) => unknown;
    session_before_compact?: (
      event: SessionBeforeCompactEvent,
      ctx: TestContext,
    ) => unknown;
    session_before_tree?: (
      event: SessionBeforeTreeEvent,
      ctx: TestContext,
    ) => unknown;
    session_tree?: (event: SessionTreeEvent, ctx: TestContext) => unknown;
    session_shutdown?: (
      event: SessionShutdownEvent,
      ctx: TestContext,
    ) => unknown;
    tool_execution_end?: (event: ToolExecutionEndEvent) => unknown;
  } = {};
  const appended: { customType: string; data: unknown }[] = [];
  const commands: Record<
    string,
    (args: string, ctx: TestContext) => Promise<void>
  > = {};
  return {
    handlers,
    appended,
    commands,
    pi: {
      on(event: keyof typeof handlers, handler: never) {
        handlers[event] = handler;
      },
      appendEntry(customType: string, data: unknown) {
        if (options.appendFails) throw new Error("disk full");
        appended.push({ customType, data });
      },
      registerCommand(
        name: string,
        options: { handler: (args: string, ctx: TestContext) => Promise<void> },
      ) {
        commands[name] = options.handler;
      },
      getAllTools: () => options.tools ?? BUILTIN_TOOLS,
    },
  };
}

function startSession(ctx: TestContext, pi: ReturnType<typeof fakePi>): void {
  lmsk(pi.pi);
  void pi.handlers.session_start?.(
    { type: "session_start", reason: "startup" },
    ctx,
  );
}

/** Moves the session to a branch that holds `branch`, then fires the tree navigation event. */
function navigateTo(
  pi: ReturnType<typeof fakePi>,
  ctx: TestContext,
  branch: BranchRecord[],
): unknown {
  ctx.sessionManager.getBranch = () => branch;
  return pi.handlers.session_tree?.(
    { type: "session_tree", newLeafId: null, oldLeafId: null },
    ctx,
  );
}

function providerRequest(text: string): BeforeProviderRequestEvent {
  return {
    type: "before_provider_request",
    payload: { messages: [{ role: "user", content: text }] },
  };
}

function maskedContent(result: unknown): string {
  return JSON.stringify(result);
}

describe("provider requests", () => {
  it("masks the provider payload before it is sent", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(CODENAME);
    expect(ctx.aborts).toBe(0);
  });

  it("keeps the fields that a provider signs or encrypts byte-exact", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const reasoning = { type: "reasoning", encrypted_content: CODENAME };

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { input: [reasoning, { role: "user", content: CODENAME }] },
      },
      ctx,
    );

    expect(result).toEqual({
      input: [
        reasoning,
        { role: "user", content: expect.not.stringContaining(CODENAME) },
      ],
    });
  });

  it.each([
    ["an environment secret", "Zq7fakeEnvValue99"],
    ["a vault value", CODENAME],
  ])(
    "blocks a request that holds %s glued to a word, which masking keeps",
    async (_, secret) => {
      writeProjectConfig();
      vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.before_provider_request?.(
        {
          type: "before_provider_request",
          payload: {
            system: "You are a coding agent.",
            messages: [{ role: "user", content: `see build_${secret}` }],
          },
        },
        ctx,
      );

      expect(result).toEqual({});
      expect(ctx.aborts).toBe(1);
      expect(ctx.notices).toEqual([
        { message: expect.stringContaining("HIDDEN_REAL"), level: "error" },
      ]);
    },
  );

  it("blocks a request that holds a configured value shorter than 8 characters glued to a word", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "pin", type: "literal", values: ["Kx-91ab"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("see build_Kx-91ab"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.aborts).toBe(1);
  });

  it("sends a configured value shorter than 4 characters glued to a word", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "pin", type: "literal", values: ["a1"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("hash it with sha1 please"),
      ctx,
    );

    expect(result).toEqual(providerRequest("hash it with sha1 please").payload);
    expect(ctx.aborts).toBe(0);
  });

  it.each(["request", "saved message"])(
    "masks every segment of a default match that a project rule overlaps, in the %s",
    async (path) => {
      // Built at run time, so no token literal is in the file.
      const jwt = [
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        "eyJzdWIiOiJvdmVybGFwLXVzZXIiLCJyb2xlIjoiYWRtaW4ifQ",
        ["Qm9yZWFs", "TGFudGVybjk3", "WHlsb3Bob25l"].join(""),
      ].join(".");
      writeJson(join(projectDir, ".pi", "lmsk.json"), {
        rules: [
          {
            id: "project-bearer",
            type: "regex",
            pattern: "Bearer eyJ[A-Za-z0-9_-]*",
          },
        ],
      });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const text = `Authorization: Bearer ${jwt} ok`;

      const result =
        path === "request"
          ? await pi.handlers.before_provider_request?.(
              providerRequest(text),
              ctx,
            )
          : await pi.handlers.message_end?.(
              { type: "message_end", message: userMessage(text) },
              ctx,
            );

      const out = JSON.stringify(result);
      expect(out).toContain("Authorization: ");
      for (const segment of jwt.split(".")) expect(out).not.toContain(segment);
    },
  );

  it("notifies with the way out on every request blocked for a glued secret", async () => {
    vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const request = providerRequest("see build_Zq7fakeEnvValue99");

    await pi.handlers.before_provider_request?.(request, ctx);
    await pi.handlers.before_provider_request?.(request, ctx);

    expect(ctx.aborts).toBe(2);
    expect(ctx.notices).toEqual([GLUED_NOTICE, GLUED_NOTICE]);
  });

  it("blocks each request for a glued secret when the notice throws", async () => {
    vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
    const pi = fakePi();
    const ctx = testContext();
    ctx.ui.notify = () => {
      throw new Error("ui broken");
    };
    startSession(ctx, pi);
    const request = providerRequest("see build_Zq7fakeEnvValue99");

    const first = await pi.handlers.before_provider_request?.(request, ctx);
    const second = await pi.handlers.before_provider_request?.(request, ctx);

    expect([first, second]).toEqual([{}, {}]);
    expect(ctx.aborts).toBe(2);
  });

  it("blocks a request for a glued secret when the abort throws", async () => {
    vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
    const pi = fakePi();
    const ctx = testContext();
    ctx.abort = () => {
      throw new Error("ctx stale");
    };
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("see build_Zq7fakeEnvValue99"),
      ctx,
    );

    expect(result).toEqual({});
  });

  it("blocks a history once a later output teaches the value glued in it", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const request = providerRequest("see build_Xk9-pL2q-Wm7z");

    const first = await pi.handlers.before_provider_request?.(request, ctx);
    await pi.handlers.tool_result?.(
      toolResult("t-1", {
        toolName: "bash",
        content: textOf('password: "Xk9-pL2q-Wm7z"'),
      }),
      ctx,
    );
    const second = await pi.handlers.before_provider_request?.(request, ctx);

    expect(maskedContent(first)).toContain("build_Xk9-pL2q-Wm7z");
    expect(second).toEqual({});
    expect(ctx.aborts).toBe(1);
  });

  it("passes a request whose history holds a fake glued to a word", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const first = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /codename (\S+?)"/.exec(first)?.[1];

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`see build_${fake} and ${CODENAME}`),
      ctx,
    );

    expect(fake).toBeDefined();
    expect(maskedContent(result)).not.toContain(CODENAME);
    expect(ctx.aborts).toBe(0);
  });

  it("returns an empty payload, aborts, and notifies with the code only when masking fails", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const payload: { self?: unknown; content: string } = { content: CODENAME };
    payload.self = payload;

    const result = await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload },
      ctx,
    );

    expect(result).toEqual({});
    expect(result).not.toBe(payload);
    expect(ctx.aborts).toBe(1);
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("PAYLOAD_SHAPE"), level: "error" },
    ]);
    expect(ctx.notices[0]?.message).not.toContain(CODENAME);
  });

  it("shows a stopped-request notice, not a block notice, when one mask fails", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const payload: { self?: unknown; content: string } = { content: CODENAME };
    payload.self = payload;

    await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload },
      ctx,
    );
    const next = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(maskedContent(next)).toContain("plain text");
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]?.message).toContain("PAYLOAD_SHAPE");
    expect(ctx.notices[0]?.message).toContain("stopped");
    expect(ctx.notices[0]?.message).not.toContain("blocked");
  });

  it("shows the block notice after an earlier stopped-request notice", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );
    const payload: { self?: unknown; content: string } = { content: CODENAME };
    payload.self = payload;
    await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload },
      ctx,
    );

    await navigateTo(pi, ctx, [
      {
        type: "custom",
        customType: VAULT_ENTRY,
        data: { namespaceId: "1".repeat(32) },
      },
    ]);
    const result = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("PAYLOAD_SHAPE"), level: "error" },
      {
        message: expect.stringContaining("STORE_REFERENCE_CONFLICT"),
        level: "error",
      },
    ]);
  });

  it("blocks every provider request when the config is invalid, and notifies once", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: "bad",
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.before_provider_request?.(providerRequest("first"), ctx);
    const second = await pi.handlers.before_provider_request?.(
      providerRequest("second"),
      ctx,
    );

    expect(second).toEqual({});
    expect(ctx.aborts).toBe(2);
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]?.level).toBe("error");
  });

  it("blocks every provider request when setup never ran", async () => {
    const pi = fakePi();
    const ctx = testContext();
    lmsk(pi.pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.aborts).toBe(1);
  });

  it("ignores the project config when the project is not trusted", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext({ trusted: false });
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(maskedContent(result)).toContain(CODENAME);
  });

  it("blocks provider requests with CONFIG_INVALID when the trusted project disables an inherited rule", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "email", enabled: false }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("contact jane.doe@example.com"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.aborts).toBe(1);
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("CONFIG_INVALID"), level: "error" },
    ]);
  });

  it("lets the global config disable an inherited rule while the trusted project adds one", async () => {
    writeGlobalConfig({ rules: [{ id: "email", enabled: false }] });
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(CODENAME);
    expect(ctx.aborts).toBe(0);
    expect(ctx.notices).toEqual([]);
  });
});

describe("local identity", () => {
  it("masks the user name and the host name in the provider payload", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const user = userInfo().username;
    const host = hostname();

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: `cwd /Users/${user}/app on ${host}` },
      },
      ctx,
    );

    const masked = maskedContent(result);
    expect(masked).not.toContain(user);
    expect(masked).not.toContain(host);
    expect(masked).toMatch(
      new RegExp(`cwd /Users/[A-Za-z0-9]{${user.length}}/app`),
    );
  });

  it("leaves the host name as written when the global level disables local-identity", async () => {
    writeGlobalConfig({ rules: [{ id: "local-identity", enabled: false }] });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const system = `build on ${hostname()}`;

    const result = await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload: { system } },
      ctx,
    );

    expect(maskedContent(result)).toContain(system);
  });

  it("keeps a word that only starts with the user name", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const user = userInfo().username;

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: `${user}ware is not a path` },
      },
      ctx,
    );

    expect(maskedContent(result)).toContain(`${user}ware is not a path`);
  });

  it("masks the global git user name and keeps the user name of the project repository", async () => {
    execFileSync("git", ["config", "--global", "user.name", "Ana Test"]);
    execFileSync("git", ["-C", projectDir, "init", "--quiet"]);
    execFileSync("git", ["-C", projectDir, "config", "user.name", "Bo Repo"]);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: "authors Ana Test and Bo Repo" },
      },
      ctx,
    );

    expect(maskedContent(result)).not.toContain("Ana Test");
    expect(maskedContent(result)).toContain("Bo Repo");
  });

  it("masks the global git user names of the global file and of an included file", async () => {
    execFileSync("git", ["config", "--global", "user.name", "Ana Home"]);
    const work = join(root, "work.gitconfig");
    execFileSync("git", ["config", "--file", work, "user.name", "Ana Work"]);
    execFileSync("git", ["config", "--global", "include.path", work]);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: "authors Ana Home and Ana Work" },
      },
      ctx,
    );

    expect(maskedContent(result)).not.toContain("Ana Home");
    expect(maskedContent(result)).not.toContain("Ana Work");
  });

  it("replaces the git name and email with fakes of the same letters, case and punctuation", async () => {
    execFileSync("git", ["config", "--global", "user.name", "Jean Dupont"]);
    execFileSync("git", [
      "config",
      "--global",
      "user.email",
      "jean.dupont@acme-corp.com",
    ]);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: "Author: Jean Dupont <jean.dupont@acme-corp.com>" },
      },
      ctx,
    );

    const masked = maskedContent(result);
    expect(masked).toMatch(
      /"Author: [A-Z][a-z]{3} [A-Z][a-z]{5} <[a-z]{4}\.[a-z]{6}@[a-z]{4}-[a-z]{4}\.[a-z]{3}>"/,
    );
    expect(masked).not.toMatch(/Jean|Dupont|jean|dupont|acme|corp/);
  });

  it("masks the account name in the global git email before the email occurs", async () => {
    execFileSync("git", [
      "config",
      "--global",
      "user.email",
      "12345+ana-dev@users.noreply.github.com",
    ]);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: "origin https://github.com/ana-dev/app.git" },
      },
      ctx,
    );

    expect(maskedContent(result)).not.toContain("ana-dev");
  });

  it("keeps the tag of a plus-addressed git email", async () => {
    execFileSync("git", [
      "config",
      "--global",
      "user.email",
      "jsmith+git@example.com",
    ]);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload: { system: "run git push" } },
      ctx,
    );

    expect(maskedContent(result)).toContain("run git push");
  });

  it("sends a request when the git user name is one character", async () => {
    execFileSync("git", ["config", "--global", "user.name", "x"]);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: `${[...alphabet].join(" ")} by x` },
      },
      ctx,
    );

    expect(ctx.aborts).toBe(0);
  });

  it("masks the short host name", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const host = hostname().split(".")[0];

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: `user@${host} %` },
      },
      ctx,
    );

    expect(maskedContent(result)).not.toContain(host);
  });

  it("masks without git identity when git is not on PATH", async () => {
    vi.stubEnv("PATH", root);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { system: `cwd /Users/${userInfo().username}/app` },
      },
      ctx,
    );

    expect(maskedContent(result)).toMatch(
      new RegExp(`cwd /Users/[A-Za-z0-9]{${userInfo().username.length}}/app`),
    );
  });

  it("restores the masked home path in bash arguments", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const user = userInfo().username;
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        {
          type: "before_provider_request",
          payload: { system: `cwd /Users/${user}/app` },
        },
        ctx,
      ),
    );
    const fake = /\/Users\/[A-Za-z0-9]+\/app/.exec(masked)?.[0] ?? "";
    expect(fake).not.toContain(`/${user}/`);
    const input = { command: `ls ${fake}` };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input },
      ctx,
    );

    expect(input.command).toBe(`ls /Users/${user}/app`);
  });
});

describe("employer names from a configured regex rule", () => {
  const EMPLOYER_RULE = {
    id: "employer",
    type: "regex",
    pattern: "\\bShell\\b|shell\\.com",
    strategy: "fixed",
    replacement: "Company{n}",
  };

  it("masks the employer name and domain, and keeps the words around them", async () => {
    writeGlobalConfig({ rules: [EMPLOYER_RULE] });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: {
          messages: [
            {
              role: "user",
              content:
                "Shell pipelines, bash shell, SHELL=/bin/zsh, jane@shell.com, shell.com",
            },
          ],
        },
      },
      ctx,
    );

    const masked = maskedContent(result);
    expect(masked).not.toContain("Shell");
    expect(masked).not.toContain("shell.com");
    expect(masked).toMatch(/Company\d pipelines/);
    expect(masked).toContain("bash shell");
    expect(masked).toContain("SHELL=/bin/zsh");
  });

  it("restores the employer fake in write and bash arguments", async () => {
    writeGlobalConfig({ rules: [EMPLOYER_RULE] });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        {
          type: "before_provider_request",
          payload: { messages: [{ role: "user", content: "Shell pipelines" }] },
        },
        ctx,
      ),
    );
    const fake = /(Company\d+) pipelines/.exec(masked)?.[1] ?? "";
    const write = { path: "notes.txt", content: `${fake} pipelines` };
    const bash = { command: `echo ${fake}` };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "write", input: write },
      ctx,
    );
    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "2", toolName: "bash", input: bash },
      ctx,
    );

    expect(write.content).toBe("Shell pipelines");
    expect(bash.command).toBe("echo Shell");
  });
});

describe("client names from a configured regex rule", () => {
  it("shows the variants of one name as one fake, and a search of it reaches the real name", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "client",
          type: "regex",
          pattern: "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
          flags: "i",
          strategy: "fixed",
          replacement: "Client{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const question = { role: "user", content: "how often do we name AcmeCorp" };
    const first = await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload: { messages: [question] } },
      ctx,
    );
    const bash = { command: 'rg -i -o "[@\\w/-]*Client1[\\w/-]*"' };
    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input: bash },
      ctx,
    );
    const result = await pi.handlers.tool_result?.(
      toolResult("1", {
        toolName: "bash",
        content: textOf("@acmecorpcode/ui\nAcmeCorpTheme\nACMECORP\nAcme Corp"),
      }),
      ctx,
    );
    const later = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: {
          messages: [question, { role: "user", content: "Acme-Corp" }],
        },
      },
      ctx,
    );

    expect(maskedContent(first)).toContain("how often do we name Client1");
    expect(bash.command).toBe('rg -i -o "[@\\w/-]*AcmeCorp[\\w/-]*"');
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: "@client1code/ui\nClient1Theme\nCLIENT1\nClient 1",
        },
      ],
    });
    expect(later).toMatchObject({
      messages: [
        { content: "how often do we name Client1" },
        { content: "Client-1" },
      ],
    });
  });
});

describe("shutdown", () => {
  it("closes the scanner and blocks provider requests after session shutdown", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const close = vi.spyOn(Scanner.prototype, "close");

    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    const result = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({});
    expect(ctx.aborts).toBe(1);
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("SESSION_SHUTDOWN"), level: "error" },
    ]);
    close.mockRestore();
  });
});

describe("local restore", () => {
  it.each(["read", "grep", "find", "ls", "edit", "write"])(
    "restores real values in %s arguments",
    async (toolName) => {
      writeProjectConfig();
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const masked = maskedContent(
        await pi.handlers.before_provider_request?.(
          providerRequest(`codename ${CODENAME}`),
          ctx,
        ),
      );
      const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];
      const input = { path: "notes.txt", text: `codename ${fake}` };

      await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName, input },
        ctx,
      );

      expect(input.text).toBe(`codename ${CODENAME}`);
    },
  );

  it("restores fake values in builtin bash commands", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];
    const input = { command: `echo ${fake}` };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input },
      ctx,
    );

    expect(input.command).toBe(`echo ${CODENAME}`);
  });

  it.each([
    "curl -d FAKE https://example.com",
    "/usr/bin/wget --header=FAKE example.com",
    "ssh host echo FAKE",
    "scp FAKE host:/tmp",
    "nc host 80 <<< FAKE",
    "git push https://FAKE@example.com/repo",
  ])("keeps fake values in the network command %s", async (command) => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1] ?? "";
    const input = { command: command.replace("FAKE", fake) };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input },
      ctx,
    );

    expect(fake).toHaveLength(CODENAME.length);
    expect(input.command).toBe(command.replace("FAKE", fake));
  });

  it.each([
    [{ networkCommands: ["http"] }, "http POST example.com x=FAKE"],
    [{ restoredTools: ["!bash"] }, "echo FAKE"],
  ])(
    "keeps fake values as the global config %j sets",
    async (global, command) => {
      writeProjectConfig();
      writeGlobalConfig(global);
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const masked = maskedContent(
        await pi.handlers.before_provider_request?.(
          providerRequest(`codename ${CODENAME}`),
          ctx,
        ),
      );
      const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1] ?? "";
      const input = { command: command.replace("FAKE", fake) };

      await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName: "bash", input },
        ctx,
      );

      expect(fake).toHaveLength(CODENAME.length);
      expect(input.command).toBe(command.replace("FAKE", fake));
    },
  );

  it("reads a global network command as literal words", async () => {
    writeProjectConfig();
    writeGlobalConfig({ networkCommands: ["(a|a)+$"] });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1] ?? "";
    const literal = { command: `(a|a)+$ ${fake}` };
    const other = { command: `echo ${"a".repeat(40)}! ${fake}` };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input: literal },
      ctx,
    );
    expect(literal.command).toBe(`(a|a)+$ ${fake}`);
    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "2", toolName: "bash", input: other },
      ctx,
    );

    expect(fake).toHaveLength(CODENAME.length);
    expect(other.command).toBe(`echo ${"a".repeat(40)}! ${CODENAME}`);
  });

  it("keeps fake values in a network command whose client name is masked", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, "curl"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME} via curl`),
        ctx,
      ),
    );
    const [, fake, client] =
      /"content":"codename (\S+) via (\S+)"/.exec(masked) ?? [];
    const input = { command: `${client} -d ${fake} https://example.com` };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input },
      ctx,
    );

    expect(client).not.toBe("curl");
    expect(input.command).toBe(`${client} -d ${fake} https://example.com`);
  });

  it.each(["mcp__notes__search"])(
    "keeps fake values in %s arguments",
    async (toolName) => {
      writeProjectConfig();
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const masked = maskedContent(
        await pi.handlers.before_provider_request?.(
          providerRequest(`codename ${CODENAME}`),
          ctx,
        ),
      );
      const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];
      const input = { command: `echo ${fake}` };

      await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName, input },
        ctx,
      );

      expect(input.command).toBe(`echo ${fake}`);
    },
  );

  it.each<[string, ToolSource[]]>([
    [
      "a same-named extension tool replaces it",
      [
        {
          name: "read",
          sourceInfo: createSyntheticSourceInfo("/ext/read.ts", {
            source: "extension",
          }),
        },
      ],
    ],
    ["pi lists no read tool", []],
    [
      "the builtin-source read is not the core read",
      [
        {
          name: "read",
          sourceInfo: createSyntheticSourceInfo("builtin:mcp", {
            source: "builtin",
          }),
        },
      ],
    ],
  ])("keeps fake values in read arguments when %s", async (_label, tools) => {
    writeProjectConfig();
    const pi = fakePi({ tools });
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];
    const input = { path: "notes.txt", text: `codename ${fake}` };

    await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "read", input },
      ctx,
    );

    expect(input.text).toBe(`codename ${fake}`);
  });

  // Contract change: assistant text is no longer restored to real values in the session.
  it("keeps assistant text masked but signed thinking byte-exact", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1] ?? "";

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: assistantMessage([
          { type: "text", text: fake },
          { type: "thinking", thinking: fake, thinkingSignature: "sig" },
        ]),
      },
      ctx,
    );

    expect(result).toMatchObject({
      message: {
        content: [
          { type: "text", text: fake },
          { type: "thinking", thinking: fake, thinkingSignature: "sig" },
        ],
      },
    });
  });
});

describe("tool-call arguments in the transcript", () => {
  it("gets a copy from pi, so restoring the tool_call input in place cannot write reals to the transcript", () => {
    const fake = "Kx91abQuillHarbor";
    const toolCall = {
      type: "toolCall" as const,
      id: "call-1",
      name: "read",
      arguments: { path: fake, options: { limit: 1 } },
    };
    const tool = {
      name: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          options: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
      },
    };

    const args = validateToolArguments(tool, toolCall);
    expect(args).not.toBe(toolCall.arguments);
    Object.assign(args, { path: "real" });
    args.options.limit = 2;

    expect(toolCall.arguments).toEqual({ path: fake, options: { limit: 1 } });
  });
});

describe("message masking before persistence", () => {
  it("masks user text in the persisted message object", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = userMessage(`codename ${CODENAME}`);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(JSON.stringify(message)).not.toContain(CODENAME);
  });

  it("masks assistant text and tool call arguments", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: assistantMessage([
          { type: "text", text: `codename ${CODENAME}` },
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: `echo ${CODENAME}` },
          },
        ]),
      },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("preserves a retryable provider status rejected by the default validators", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const errorMessage = '503: {"message":"Injected provider failure"}';
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage,
    };
    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    expect(result).toMatchObject({
      message: { errorMessage, stopReason: "error" },
    });
  });

  it("keeps the retry decision of a provider error whose masking changes its status", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [
        {
          id: "retry-status",
          type: "literal",
          values: ["503"],
          strategy: "fixed",
          replacement: "400-{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: '503: {"message":"Injected provider failure"}',
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    expect(ctx.notices).toEqual([]);
    const persisted = (result as { message: AssistantMessage }).message;

    expect(persisted.errorMessage).toBe("503 provider error, text withheld");
    expect(isRetryableAssistantError(persisted)).toBe(true);
  });

  it("masks system context text and sections", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "system",
          content: "",
          sections: { context: `<context>codename ${CODENAME}</context>` },
          timestamp: 1,
        },
      },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("masks tool result content and details", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: `codename ${CODENAME}` }],
          details: { path: CODENAME },
          isError: false,
          timestamp: 1,
        },
      },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("withholds a tool result and aborts the run when its masking is blocked", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "custom",
        input: {},
        content: [{ type: "text", text: `codename ${CODENAME}` }],
        details: { path: CODENAME },
        isError: false,
      } as ToolResultEvent,
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(ctx.aborts).toBe(1);
  });

  it("withholds a tool result whose details are over the payload limit", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "custom",
        input: {},
        content: [{ type: "text", text: "done" }],
        details: { blob: "a".repeat(PAYLOAD_LIMIT_TEXT_LENGTH) },
        isError: false,
      } as ToolResultEvent,
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "[MASKED]" }],
      details: "[MASKED]",
    });
    expect(ctx.aborts).toBe(1);
  });

  it("masks tool result content, details and structured content", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "custom",
        input: {},
        content: [{ type: "text", text: `codename ${CODENAME}` }],
        details: { path: CODENAME },
        structuredContent: { value: CODENAME },
        isError: false,
      } as ToolResultEvent,
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text" }],
      details: { path: expect.any(String) },
      structuredContent: { value: expect.any(String) },
    });
    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("withholds a tool result message whose details are over the payload limit", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "custom",
          content: [{ type: "text", text: "done" }],
          details: { blob: "a".repeat(PAYLOAD_LIMIT_TEXT_LENGTH) },
          isError: false,
          timestamp: 1,
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      message: { content: [{ type: "text", text: "[MASKED]" }] },
    });
    expect(JSON.stringify(result)).not.toContain("aaaa");
    expect(ctx.aborts).toBe(1);
  });

  it("masks a message that arrives during another mask, and keeps raw text out of it", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const first = userMessage(`codename ${CODENAME}`);
    const second = userMessage(`codename ${CODENAME}`);

    const pending = pi.handlers.message_end?.(
      { type: "message_end", message: first },
      ctx,
    );
    const masked = await pi.handlers.message_end?.(
      { type: "message_end", message: second },
      ctx,
    );
    await pending;

    expect(JSON.stringify(second)).not.toContain(CODENAME);
    expect(JSON.stringify(masked)).not.toContain(CODENAME);
    expect(masked).toMatchObject({
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringMatching(/^codename [A-Za-z0-9]{19}$/),
          },
        ],
      },
    });
    expect(ctx.aborts).toBe(0);
  });

  it("withholds a message when the UI report throws", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    ctx.ui.notify = () => {
      throw new Error("no ui");
    };
    startSession(ctx, pi);
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      ctx,
    );
    const message = userMessage(`codename ${CODENAME}`);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );

    expect(JSON.stringify(message)).not.toContain(CODENAME);
    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("masks a configured secret in the provider error and keeps it retryable", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: `503: {"message":"upstream rejected ${CODENAME}"}`,
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(persisted.errorMessage).toContain("503");
    expect(isRetryableAssistantError(persisted)).toBe(true);
  });

  it("keeps a masked quota error non-retryable", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: `429 insufficient_quota for ${CODENAME}`,
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(isRetryableAssistantError(persisted)).toBe(false);
  });

  it("masks a configured override of a personal-data rule in the provider error", async () => {
    writeGlobalConfig({
      rules: [{ id: "email", pattern: "\\bUmbra-Vellum-Sixty\\b" }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: `503: {"message":"upstream rejected Umbra-Vellum-Sixty"}`,
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain("Umbra-Vellum-Sixty");
    expect(isRetryableAssistantError(persisted)).toBe(true);
  });

  it("keeps a retryable error retryable when a learned value matches its status text", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "status-line",
          type: "regex",
          pattern: "status: (HTTP 503)",
          group: 1,
          strategy: "fixed",
          replacement: "hidden-{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.message_end?.(
      { type: "message_end", message: userMessage("status: HTTP 503") },
      ctx,
    );
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: "upstream returned HTTP 503",
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain("HTTP 503");
    expect(isRetryableAssistantError(persisted)).toBe(true);
  });

  it("keeps a quota error non-retryable when a learned value matches its quota text", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "quota-line",
          type: "regex",
          pattern: "quota: (insufficient_quota)",
          group: 1,
          strategy: "fixed",
          replacement: "hidden-{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: userMessage("quota: insufficient_quota"),
      },
      ctx,
    );
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: "429 insufficient_quota",
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain("insufficient_quota");
    expect(isRetryableAssistantError(persisted)).toBe(false);
  });

  it("keeps a context overflow error an overflow when masking removes its overflow text", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "overflow-phrase",
          type: "literal",
          values: ["prompt is too long"],
          strategy: "fixed",
          replacement: "hidden-{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: "prompt is too long",
    };
    expect(isContextOverflow(message)).toBe(true);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain("prompt is too long");
    expect(isContextOverflow(persisted)).toBe(true);
    expect(isRetryableAssistantError(persisted)).toBe(false);
  });

  it("keeps a retryable context overflow error an overflow and retryable when masking removes its overflow text", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "overflow-phrase",
          type: "literal",
          values: ["prompt is too long"],
          strategy: "fixed",
          replacement: "hidden-{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: "503 prompt is too long",
    };
    expect(isContextOverflow(message)).toBe(true);
    expect(isRetryableAssistantError(message)).toBe(true);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(JSON.stringify(result)).not.toContain("prompt is too long");
    expect(isContextOverflow(persisted)).toBe(true);
    expect(isRetryableAssistantError(persisted)).toBe(true);
  });

  it("does not make a non-overflow error an overflow when masking adds overflow text", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "rejection",
          type: "literal",
          values: ["upstream rejected"],
          strategy: "fixed",
          replacement: "prompt is too long {n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: "upstream rejected",
    };
    expect(isContextOverflow(message)).toBe(false);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(isContextOverflow(persisted)).toBe(false);
    expect(isRetryableAssistantError(persisted)).toBe(false);
  });

  it("does not make a retryable error an overflow when masking changes its retry decision", async () => {
    writeGlobalConfig({
      rules: [
        {
          id: "status",
          type: "literal",
          values: ["503"],
          strategy: "fixed",
          replacement: "400-{n}",
        },
      ],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: "503 upstream failure",
    };
    expect(isRetryableAssistantError(message)).toBe(true);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );
    const persisted = (result as { message: AssistantMessage }).message;

    expect(isRetryableAssistantError(persisted)).toBe(true);
    expect(isContextOverflow(persisted)).toBe(false);
  });

  it("keeps an unchanged signed text block byte-exact", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: assistantMessage([
          { type: "text", text: "plain answer", textSignature: "sig" },
        ]),
      },
      ctx,
    );

    expect(result).toEqual({
      message: expect.objectContaining({
        content: [{ type: "text", text: "plain answer", textSignature: "sig" }],
      }),
    });
    expect(ctx.aborts).toBe(0);
  });

  it("withholds a signed text block that would change under masking", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: assistantMessage([
          {
            type: "text",
            text: `codename ${CODENAME}`,
            textSignature: "sig",
          },
        ]),
      },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(result).toMatchObject({
      message: { content: [{ type: "text", text: "[MASKED]" }] },
    });
    expect(ctx.aborts).toBe(1);
  });

  it("withholds a signed tool call whose arguments would change under masking", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: assistantMessage([
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: `echo ${CODENAME}` },
            thoughtSignature: "sig",
          },
        ]),
      },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(result).toMatchObject({
      message: { content: [{ type: "text", text: "[MASKED]" }] },
    });
    expect(ctx.aborts).toBe(1);
  });

  it("withholds a signed tool call so its same-model replay carries no call or signature", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message: googleToolCall(`echo ${CODENAME}`) },
      ctx,
    );
    const replay = googleReplay(
      (result as { message: AssistantMessage }).message,
    );

    expect(replay).not.toContain(GOOGLE_SIGNATURE);
    expect(replay).not.toContain("functionCall");
    expect(ctx.aborts).toBe(1);
  });

  it("keeps the signature of an unchanged signed tool call in its same-model replay", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message: googleToolCall("echo ok") },
      ctx,
    );
    const replay = googleReplay(
      (result as { message: AssistantMessage }).message,
    );

    expect(replay).toContain(GOOGLE_SIGNATURE);
    expect(replay).toContain("functionCall");
    expect(ctx.aborts).toBe(0);
  });

  it("masks nested call arguments and error text", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message: nestedToolResult(CODENAME) },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(result).toMatchObject({
      message: {
        nestedCalls: { calls: [{ name: "bash", status: "error" }] },
      },
    });
  });

  it("withholds nested call records when masking is blocked", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      ctx,
    );
    const message = nestedToolResult(CODENAME);

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );

    expect(JSON.stringify(message)).not.toContain(CODENAME);
    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(JSON.stringify(result)).not.toContain("nestedCalls");
    expect(message.nestedCalls).toBeUndefined();
  });

  it("keeps nested call records of a message that waits for a concurrent mask", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const second = nestedToolResult(CODENAME);

    const pending = pi.handlers.message_end?.(
      { type: "message_end", message: userMessage(`codename ${CODENAME}`) },
      ctx,
    );
    const masked = await pi.handlers.message_end?.(
      { type: "message_end", message: second },
      ctx,
    );
    await pending;

    expect(JSON.stringify(second)).not.toContain(CODENAME);
    expect(JSON.stringify(masked)).not.toContain(CODENAME);
    expect(masked).toMatchObject({
      message: {
        nestedCalls: { calls: [{ name: "bash", status: "error" }] },
      },
    });
    expect(ctx.aborts).toBe(0);
  });

  it("masks custom message content and details", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "notes",
          content: `codename ${CODENAME}`,
          display: true,
          details: { nested: [CODENAME] },
          timestamp: 1,
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      message: { role: "custom", customType: "notes" },
    });
    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("masks custom message content blocks", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "notes",
          content: [{ type: "text", text: `codename ${CODENAME}` }],
          display: true,
          timestamp: 1,
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      message: { role: "custom", content: [{ type: "text" }] },
    });
    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("withholds a custom message when masking is blocked", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      ctx,
    );
    const message = {
      role: "custom" as const,
      customType: "notes",
      content: `codename ${CODENAME}`,
      display: true,
      details: { nested: [CODENAME] },
      timestamp: 1,
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );

    expect(JSON.stringify(message)).not.toContain(CODENAME);
    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(result).toMatchObject({
      message: { role: "custom", content: "[MASKED]" },
    });
    expect(ctx.aborts).toBe(1);
  });

  it("withholds the provider error when masking is blocked", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      ctx,
    );
    const message = {
      ...assistantMessage([]),
      stopReason: "error" as const,
      errorMessage: `503: ${CODENAME}`,
    };

    const result = await pi.handlers.message_end?.(
      { type: "message_end", message },
      ctx,
    );

    expect(JSON.stringify(message)).not.toContain(CODENAME);
    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(result).toMatchObject({ message: { stopReason: "error" } });
    const persisted = (result as { message: AssistantMessage }).message;
    expect(isRetryableAssistantError(persisted)).toBe(false);
  });

  it("masks signature-shaped keys in tool result details", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "custom",
        input: {},
        content: [{ type: "text", text: "done" }],
        details: {
          signature: CODENAME,
          encrypted_content: CODENAME,
          sibling: { signature: "sig", text: CODENAME },
        },
        isError: false,
      } as ToolResultEvent,
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
  });

  it("neutralizes the tool result before its masking await", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const event = {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "custom",
      input: {},
      content: [{ type: "text", text: `codename ${CODENAME}` }],
      details: { path: CODENAME },
      structuredContent: { value: CODENAME },
      isError: false,
    } as ToolResultEvent;

    const pending = pi.handlers.tool_result?.(event, ctx);

    expect(JSON.stringify(event)).not.toContain(CODENAME);
    await pending;
  });

  it("returns the neutral tool result when abort and the UI report both throw", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    ctx.abort = () => {
      throw new Error("no abort");
    };
    ctx.ui.notify = () => {
      throw new Error("no ui");
    };
    startSession(ctx, pi);
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "custom",
        input: {},
        content: [{ type: "text", text: `codename ${CODENAME}` }],
        details: { path: CODENAME },
        isError: false,
      } as ToolResultEvent,
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(CODENAME);
    expect(result).toEqual({
      content: [{ type: "text", text: "[MASKED]" }],
      details: "[MASKED]",
    });
  });

  it("leaves bashExecution messages outside the masking contract", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "bashExecution",
          command: `echo ${CODENAME}`,
          output: CODENAME,
          timestamp: 1,
        },
      } as MessageEndEvent,
      ctx,
    );

    expect(result).toBeUndefined();
  });
});

describe("vault persistence", () => {
  it("appends only a namespace reference, never a real pair", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(pi.appended).toEqual([
      {
        customType: VAULT_ENTRY,
        data: { namespaceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
      },
    ]);
    expect(JSON.stringify(pi.appended)).not.toContain(CODENAME);
  });

  it("publishes the reference to an empty store before it saves the mapping", async () => {
    writeProjectConfig();
    const pi = fakePi();
    let published: unknown;
    let storedWhenPublished: unknown;
    pi.pi.appendEntry = (_customType, data) => {
      published = data;
      storedWhenPublished = storeEntries(namespaceOf(data));
    };
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(storedWhenPublished).toEqual([]);
    expect(storeEntries(namespaceOf(published))).toEqual([
      [CODENAME, expect.any(String)],
    ]);
  });

  it("rebuilds the vault on resume from the store alone, so a real keeps its fake", async () => {
    writeProjectConfig();
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    const before = maskedContent(
      await first.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        firstCtx,
      ),
    );
    const branch = first.appended.map((entry) => ({
      type: "custom",
      customType: entry.customType,
      data: entry.data,
    }));
    expect(JSON.stringify(branch)).not.toContain(CODENAME);

    const second = fakePi();
    const resumedCtx = testContext({ branch });
    startSession(resumedCtx, second);
    const after = maskedContent(
      await second.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        resumedCtx,
      ),
    );

    expect(after).toBe(before);
    expect(second.appended).toEqual([]);
  });
});

describe("concurrent masking", () => {
  it("masks both results of parallel read and bash calls without an abort", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const read = pi.handlers.tool_result?.(
      toolResult("read-1", {
        toolName: "read",
        content: textOf(`codename ${CODENAME}`),
      }),
      ctx,
    );
    const bash = pi.handlers.tool_result?.(
      toolResult("bash-1", {
        toolName: "bash",
        content: textOf(`codename ${OTHER}`),
      }),
      ctx,
    );
    const results = await Promise.all([read, bash]);

    expect(results).toMatchObject([
      {
        content: [
          {
            type: "text",
            text: expect.stringMatching(/^codename [A-Za-z0-9]{19}$/),
          },
        ],
      },
      {
        content: [
          {
            type: "text",
            text: expect.stringMatching(/^codename [A-Za-z0-9]{20}$/),
          },
        ],
      },
    ]);
    expect(ctx.aborts).toBe(0);
    expect(ctx.notices).toEqual([]);
  });

  it("fails closed for both concurrent requests when the save of the first fails", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      firstCtx,
    );
    const namespaceId = namespaceOf(first.appended[0]?.data);

    const branch = first.appended.map((entry) => ({
      type: "custom",
      customType: entry.customType,
      data: entry.data,
    }));
    const second = fakePi();
    const ctx = testContext({ branch });
    startSession(ctx, second);
    const failing = second.handlers.before_provider_request?.(
      providerRequest(`codename ${OTHER}`),
      ctx,
    );
    const waiting = second.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );
    writeFileSync(join(agentDir, VAULT_STORE_DIR, `${namespaceId}.lock`), "");

    expect(await Promise.all([failing, waiting])).toEqual([{}, {}]);
    expect(ctx.aborts).toBe(2);
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("STORE_BUSY"), level: "error" },
    ]);
    expect(second.appended).toEqual([]);
  });

  it("saves every mapping of concurrent requests, in request order", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const [, otherRequest] = await Promise.all([
      pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
      pi.handlers.before_provider_request?.(
        providerRequest(`codename ${OTHER}`),
        ctx,
      ),
    ]);

    const namespaceId = namespaceOf(pi.appended[0]?.data);
    expect(pi.appended).toHaveLength(1);
    expect(storeEntries(namespaceId)).toEqual([
      [CODENAME, expect.any(String)],
      [OTHER, expect.any(String)],
    ]);
    expect(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${OTHER}`),
        ctx,
      ),
    ).toEqual(otherRequest);
  });
});

describe("vault store", () => {
  /** The session branch a fork or resume would rebuild from the appended entries. */
  function branchOf(pi: ReturnType<typeof fakePi>) {
    return pi.appended.map((entry) => ({
      type: "custom",
      customType: entry.customType,
      data: entry.data,
    }));
  }

  it("creates no store and no reference when nothing is learned", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(pi.appended).toEqual([]);
    expect(existsSync(join(agentDir, VAULT_STORE_DIR))).toBe(false);
  });

  it("blocks requests when the referenced store is missing", async () => {
    writeProjectConfig();
    const branch = [
      {
        type: "custom",
        customType: VAULT_ENTRY,
        data: { namespaceId: "0".repeat(32) },
      },
    ];
    const pi = fakePi();
    const ctx = testContext({ branch });
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("STORE_MISSING"), level: "error" },
    ]);
  });

  it("blocks requests when the referenced store is corrupt", async () => {
    writeProjectConfig();
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      firstCtx,
    );
    const namespaceId = namespaceOf(first.appended[0]?.data);
    writeFileSync(join(agentDir, VAULT_STORE_DIR, `${namespaceId}.json`), "{");

    const second = fakePi();
    const ctx = testContext({ branch: branchOf(first) });
    startSession(ctx, second);
    const result = await second.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("STORE_CORRUPT"), level: "error" },
    ]);
  });

  it("rejects a reference that is not a store ID", async () => {
    writeProjectConfig();
    const branch = [
      {
        type: "custom",
        customType: VAULT_ENTRY,
        data: { namespaceId: "../escape" },
      },
    ];
    const pi = fakePi();
    const ctx = testContext({ branch });
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.notices).toEqual([
      {
        message: expect.stringContaining("STORE_INVALID_ID"),
        level: "error",
      },
    ]);
  });

  it("blocks a legacy session entry that holds real mappings", async () => {
    writeProjectConfig();
    const branch = [
      {
        type: "custom",
        customType: VAULT_ENTRY,
        data: { entries: [[CODENAME, "Fake-Fake-Fake-1"]] },
      },
    ];
    const pi = fakePi();
    const ctx = testContext({ branch });
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("VAULT_LEGACY"), level: "error" },
    ]);
    expect(JSON.stringify(ctx.notices)).not.toContain(CODENAME);
  });

  it("blocks requests with the save error code when a stale lock holds the store", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      firstCtx,
    );
    const namespaceId = namespaceOf(first.appended[0]?.data);
    writeFileSync(join(agentDir, VAULT_STORE_DIR, `${namespaceId}.lock`), "");

    const second = fakePi();
    const ctx = testContext({ branch: branchOf(first) });
    startSession(ctx, second);
    const result = await second.handlers.before_provider_request?.(
      providerRequest(OTHER),
      ctx,
    );
    const next = await second.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({});
    expect(next).toEqual({});
    expect(second.appended).toEqual([]);
    expect(ctx.aborts).toBe(2);
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("STORE_BUSY"), level: "error" },
    ]);
    expect(JSON.stringify(ctx.notices)).not.toContain(OTHER);
  });

  it("does not save or publish a mask that finishes after its session was replaced", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const gate = new EventEmitter();
    const held = once(gate, "held");
    const released = once(gate, "released");
    const scanWorker = Scanner.prototype.scan;
    const scan = vi
      .spyOn(Scanner.prototype, "scan")
      .mockImplementationOnce(async function (this: Scanner, patterns, texts) {
        const found = await scanWorker.call(this, patterns, texts);
        gate.emit("held");
        await released;
        return found;
      });

    const stale = pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );
    await held;
    await pi.handlers.session_start?.(
      { type: "session_start", reason: "reload" },
      ctx,
    );
    gate.emit("released");
    const result = await stale;

    expect(pi.appended).toEqual([]);
    expect(existsSync(join(agentDir, VAULT_STORE_DIR))).toBe(false);
    expect(result).toEqual({});
    expect(ctx.notices).toEqual([]);
    scan.mockRestore();
  });

  it("masks a concurrent request after another mask is saved", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const first = pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );
    const second = pi.handlers.before_provider_request?.(
      providerRequest(OTHER),
      ctx,
    );

    expect(maskedContent(await first)).not.toContain(CODENAME);
    expect(maskedContent(await second)).not.toContain(OTHER);
    expect(ctx.aborts).toBe(0);
    expect(ctx.notices).toEqual([]);
  });

  it("refuses requests after a save conflict until the session reloads", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(CODENAME),
      firstCtx,
    );

    const second = fakePi();
    const secondCtx = testContext({ branch: branchOf(first) });
    startSession(secondCtx, second);
    await second.handlers.before_provider_request?.(
      providerRequest(OTHER),
      secondCtx,
    );

    const conflicted = await first.handlers.before_provider_request?.(
      providerRequest(OTHER),
      firstCtx,
    );
    const blocked = await first.handlers.before_provider_request?.(
      providerRequest("plain text"),
      firstCtx,
    );

    expect(conflicted).toEqual({});
    expect(blocked).toEqual({});
    expect(firstCtx.notices).toEqual([
      { message: expect.stringContaining("STORE_CONFLICT"), level: "error" },
    ]);

    const third = fakePi();
    const reloadedCtx = testContext({ branch: branchOf(first) });
    startSession(reloadedCtx, third);
    const restored = await third.handlers.before_provider_request?.(
      providerRequest(OTHER),
      reloadedCtx,
    );

    expect(maskedContent(restored)).not.toContain(OTHER);
    expect(reloadedCtx.aborts).toBe(0);
  });

  it("publishes the reference on a branch navigated to before it held one", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      firstCtx,
    );
    const reference = {
      customType: VAULT_ENTRY,
      data: { namespaceId: namespaceOf(first.appended[0]?.data) },
    };

    await navigateTo(first, firstCtx, []);
    expect(first.appended).toEqual([reference, reference]);

    const navigated = [{ type: "custom", ...reference }];
    firstCtx.sessionManager.getBranch = () => navigated;
    const learned = maskedContent(
      await first.handlers.before_provider_request?.(
        providerRequest(`codename ${OTHER}`),
        firstCtx,
      ),
    );
    expect(first.appended).toHaveLength(2);

    const resumed = fakePi();
    const resumedCtx = testContext({ branch: navigated });
    startSession(resumedCtx, resumed);
    const restored = maskedContent(
      await resumed.handlers.before_provider_request?.(
        providerRequest(`codename ${OTHER}`),
        resumedCtx,
      ),
    );

    expect(learned).not.toContain(OTHER);
    expect(restored).toBe(learned);
    expect(resumed.appended).toEqual([]);
  });

  it("publishes the reference on the summary target when the summary created the store", async () => {
    writeProjectConfig();
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.session_before_tree?.(
      treeEvent(`codename ${CODENAME}`),
      firstCtx,
    );
    const reference = {
      customType: VAULT_ENTRY,
      data: { namespaceId: namespaceOf(first.appended[0]?.data) },
    };

    await navigateTo(first, firstCtx, []);
    expect(first.appended).toEqual([reference, reference]);

    const target = [{ type: "custom", ...reference }];
    const learned = maskedContent(
      await first.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        firstCtx,
      ),
    );
    const resumed = fakePi();
    const resumedCtx = testContext({ branch: target });
    startSession(resumedCtx, resumed);
    const restored = maskedContent(
      await resumed.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        resumedCtx,
      ),
    );

    expect(learned).not.toContain(CODENAME);
    expect(restored).toBe(learned);
    expect(resumed.appended).toEqual([]);
  });

  it("blocks requests when the navigated branch references another store", async () => {
    writeProjectConfig();
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      firstCtx,
    );

    await navigateTo(first, firstCtx, [
      {
        type: "custom",
        customType: VAULT_ENTRY,
        data: { namespaceId: "1".repeat(32) },
      },
    ]);
    const result = await first.handlers.before_provider_request?.(
      providerRequest("plain text"),
      firstCtx,
    );

    expect(result).toEqual({});
    expect(firstCtx.notices).toEqual([
      {
        message: expect.stringContaining("STORE_REFERENCE_CONFLICT"),
        level: "error",
      },
    ]);
    expect(first.appended).toHaveLength(1);
  });

  it("blocks requests when navigation cannot read the branch", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    ctx.sessionManager.getBranch = () => {
      throw new Error("branch unreadable");
    };

    await pi.handlers.session_tree?.(
      { type: "session_tree", newLeafId: null, oldLeafId: null },
      ctx,
    );
    const result = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("UNEXPECTED_ERROR"), level: "error" },
    ]);
  });

  it("blocks requests of the earlier session when the next one cannot read its branch", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const next = testContext();
    next.sessionManager.getBranch = () => {
      throw new Error("branch unreadable");
    };

    expect(() =>
      pi.handlers.session_start?.(
        { type: "session_start", reason: "resume" },
        next,
      ),
    ).not.toThrow();
    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      next,
    );

    expect(result).toEqual({});
    expect(next.notices).toEqual([
      { message: expect.stringContaining("UNEXPECTED_ERROR"), level: "error" },
    ]);
  });

  it("confirms a reloaded store before it publishes an unchanged mapping", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME, OTHER] }],
    });
    const first = fakePi();
    const firstCtx = testContext();
    startSession(firstCtx, first);
    await first.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      firstCtx,
    );
    const branch = branchOf(first);
    const namespaceId = namespaceOf(first.appended[0]?.data);

    // The rename commits before the directory flush fails, so OTHER is visible on reload.
    faults.directoryFlushFails = true;
    const second = fakePi();
    const secondCtx = testContext({ branch });
    startSession(secondCtx, second);
    const learned = await second.handlers.before_provider_request?.(
      providerRequest(`codename ${OTHER}`),
      secondCtx,
    );
    const next = await second.handlers.before_provider_request?.(
      providerRequest("plain text"),
      secondCtx,
    );

    expect(learned).toEqual({});
    expect(next).toEqual({});
    expect(secondCtx.notices).toEqual([
      { message: expect.stringContaining("STORE_IO"), level: "error" },
    ]);
    expect(
      loadVaultStore(join(agentDir, VAULT_STORE_DIR), namespaceId).revision,
    ).toBe(2);

    const reloaded = fakePi();
    const reloadedCtx = testContext({ branch });
    startSession(reloadedCtx, reloaded);
    const unchanged = await reloaded.handlers.before_provider_request?.(
      providerRequest(`codename ${OTHER}`),
      reloadedCtx,
    );

    expect(unchanged).toEqual({});
    expect(reloadedCtx.notices).toEqual([
      { message: expect.stringContaining("STORE_IO"), level: "error" },
    ]);

    faults.directoryFlushFails = false;
    const recovered = fakePi();
    const recoveredCtx = testContext({ branch });
    startSession(recoveredCtx, recovered);
    const released = await recovered.handlers.before_provider_request?.(
      providerRequest(`codename ${OTHER}`),
      recoveredCtx,
    );

    expect(maskedContent(released)).not.toContain(OTHER);
    expect(recoveredCtx.aborts).toBe(0);
    expect(recovered.appended).toEqual([]);
  });
});

describe("compaction and summaries", () => {
  it("summarizes the compaction through the masked provider stream", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);
    const event = compactionEvent([userMessage(`codename ${CODENAME}`)]);

    const result = await pi.handlers.session_before_compact?.(event, ctx);

    expect(result).toMatchObject({
      compaction: {
        summary: expect.stringContaining("Keep going"),
        firstKeptEntryId: "entry-1",
        tokensBefore: 1,
      },
    });
    expect(provider.bodies).toHaveLength(1);
    expect(JSON.stringify(provider.bodies)).not.toContain(CODENAME);
  });

  it("keeps a protected value out of the custom instructions sent to the provider", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);
    const event = compactionEvent(
      [userMessage("plain")],
      `focus on ${CODENAME}`,
    );

    const result = await pi.handlers.session_before_compact?.(event, ctx);

    expect(result).toMatchObject({
      compaction: { summary: expect.stringContaining("Keep going") },
    });
    expect(JSON.stringify(provider.bodies)).not.toContain(CODENAME);
  });

  it.each([
    ["an error", "error"],
    ["a length stop", "length"],
  ] as const)(
    "cancels compaction when the provider ends with %s",
    async (_label, stopReason) => {
      writeProjectConfig();
      const pi = fakePi();
      const ctx = testContext({
        provider: providerStub({ text: "partial", stopReason }),
      });
      startSession(ctx, pi);

      const result = await pi.handlers.session_before_compact?.(
        compactionEvent([userMessage("plain")]),
        ctx,
      );

      expect(result).toEqual({ cancel: true });
      expect(ctx.notices).toContainEqual({
        message: expect.stringContaining("SUMMARY_BLOCKED"),
        level: "error",
      });
    },
  );

  it("saves the compaction mapping and publishes only its reference", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage(`codename ${CODENAME}`)]),
      ctx,
    );

    expect(result).toMatchObject({
      compaction: { summary: expect.stringContaining("Keep going") },
    });
    expect(pi.appended).toEqual([
      {
        customType: VAULT_ENTRY,
        data: { namespaceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
      },
    ]);
    // The summary prompt adds its own mappings, so only the codename's mapping is pinned here.
    expect(storeEntries(namespaceOf(pi.appended[0]?.data))).toEqual(
      expect.arrayContaining([[CODENAME, expect.any(String)]]),
    );
  });

  it("cancels compaction when the vault entries cannot be persisted", async () => {
    writeProjectConfig();
    const pi = fakePi({ appendFails: true });
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage(`codename ${CODENAME}`)]),
      ctx,
    );
    const next = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
    expect(ctx.notices).toContainEqual({
      message: expect.stringContaining("SUMMARY_BLOCKED"),
      level: "error",
    });
    expect(next).toEqual({});
    expect(ctx.notices).toContainEqual({
      message: expect.stringContaining("UNEXPECTED_ERROR"),
      level: "error",
    });
  });

  it("cancels compaction when persistence fails and the notification throws", async () => {
    writeProjectConfig();
    const pi = fakePi({ appendFails: true });
    const ctx = testContext();
    ctx.ui.notify = () => {
      throw new Error("UI closed");
    };
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage(`codename ${CODENAME}`)]),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
  });

  it("cancels the branch summary when persistence fails and the notification throws", async () => {
    writeProjectConfig();
    const pi = fakePi({ appendFails: true });
    const ctx = testContext();
    ctx.ui.notify = () => {
      throw new Error("UI closed");
    };
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_tree?.(
      treeEvent(`codename ${CODENAME}`),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
  });

  it("summarizes the branch through the masked provider stream", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_tree?.(
      treeEvent(`codename ${CODENAME}`),
      ctx,
    );

    expect(result).toMatchObject({
      summary: { summary: expect.stringContaining("Keep going") },
    });
    expect(provider.bodies).toHaveLength(1);
    expect(JSON.stringify(provider.bodies)).not.toContain(CODENAME);
  });

  it("cancels the branch summary when the provider ends with an error", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext({
      provider: providerStub({ text: "partial", stopReason: "error" }),
    });
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_tree?.(
      treeEvent("plain"),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
  });

  it("cancels compaction without a provider request when the history holds a secret glued to a word", async () => {
    vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage("see build_Zq7fakeEnvValue99")]),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
    expect(provider.bodies).toEqual([]);
  });

  it("cancels the branch summary without a provider request when the branch holds a secret glued to a word", async () => {
    vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_tree?.(
      treeEvent("see build_Zq7fakeEnvValue99"),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
    expect(provider.bodies).toEqual([]);
  });

  it("cancels compaction and branch summary without a provider request when config is invalid", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: "bad",
    });
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const compacted = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage("plain")]),
      ctx,
    );
    const branch = await pi.handlers.session_before_tree?.(
      treeEvent("plain"),
      ctx,
    );

    expect(compacted).toEqual({ cancel: true });
    expect(branch).toEqual({ cancel: true });
    expect(provider.bodies).toEqual([]);
    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("CONFIG_INVALID"), level: "error" },
    ]);
  });
});

describe("protected paths", () => {
  it.each(["read", "grep", "find", "ls"] as const)(
    "blocks %s on a protected path",
    async (toolName) => {
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.tool_call?.(
        toolCallEvent(toolName, ".env.local"),
        ctx,
      );

      expect(result).toMatchObject({ block: true });
    },
  );

  it.each([
    "/home/u/.local/state/lmsk/vaults/a.json",
    "/xdg-state/lmsk/vaults/a.json",
  ])("blocks a read of the lmsk proxy vault %s", async (path) => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", path),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("blocks a read whose fake path restores to a protected path", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME] }],
      protectedPaths: [`**/${CODENAME}*`],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", fake ?? ""),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("blocks reads of the vault and configuration files of the extension", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const paths = [
      join(agentDir, "lmsk-vaults", "session.json"),
      join(agentDir, "lmsk", "config.json"),
      join(projectDir, ".pi", "lmsk.json"),
    ];

    const results = await Promise.all(
      paths.map((path) =>
        pi.handlers.tool_call?.(toolCallEvent("read", path), ctx),
      ),
    );

    expect(results).toEqual(
      paths.map(() => expect.objectContaining({ block: true })),
    );
  });

  it("blocks a read of a protected file through pi's @ prefix", async () => {
    writeFileSync(join(projectDir, ".env"), "note=FIXTURE-NOT-A-SECRET\n");
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const event = toolCallEvent("read", "@.env");

    const result = await pi.handlers.tool_call?.(event, ctx);
    const content =
      result ??
      (await createReadTool(projectDir).execute("1", { path: "@.env" }))
        .content;

    expect(content).toMatchObject({ block: true });
  });

  it("blocks a read of a protected path written with a Unicode space", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      protectedPaths: ["**/private notes.txt"],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", "private\u00A0notes.txt"),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("blocks a read of a protected path written from ~", async () => {
    vi.stubEnv("HOME", root);
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      protectedPaths: [`${root}/keys/**`],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", "~/keys/a.txt"),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("blocks a listing of a protected home written as a bare ~", async () => {
    vi.stubEnv("HOME", root);
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      protectedPaths: [root],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(toolCallEvent("ls", "~"), ctx);

    expect(result).toMatchObject({ block: true });
  });

  it("blocks a read of a protected path written as a file URL", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      protectedPaths: [`${root}/keys/**`],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", `file://${root}/keys/a.txt`),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("blocks a read of a link to a protected file", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      protectedPaths: ["**/private-notes.txt"],
    });
    writeFileSync(join(projectDir, "private-notes.txt"), "note=FIXTURE\n");
    symlinkSync("private-notes.txt", join(projectDir, "README.txt"));
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", "README.txt"),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("allows a read of a path that is not protected", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("read", "src/app.ts"),
      ctx,
    );

    expect(result).toBeUndefined();
  });
});

describe("model guard", () => {
  it("masks the text of classify and generateImages inputs before the call", async () => {
    const forwarded: ClassifierContext[] = [];
    const images: ImagesContext[] = [];
    const registry = {
      classify: async (_model: unknown, context: ClassifierContext) => {
        forwarded.push(context);
        throw new Error("unused");
      },
      generateImages: async (_model: unknown, context: ImagesContext) => {
        images.push(context);
        throw new Error("unused");
      },
    };
    const mask = vi.fn(async (text: string) =>
      text.replace(CODENAME, "Masked-Value-0001"),
    );
    installModelGuard(registry, mask);

    await registry
      .classify(classifierModel(), {
        state: { note: `codename ${CODENAME}` },
        questions: {},
      })
      .catch(() => undefined);
    await registry
      .generateImages(imageModel(), {
        input: [{ type: "text", text: `codename ${CODENAME}` }],
      })
      .catch(() => undefined);

    expect(forwarded[0]?.state).toEqual({ note: "codename Masked-Value-0001" });
    expect(images[0]?.input).toEqual([
      { type: "text", text: "codename Masked-Value-0001" },
    ]);
  });

  it.each<[string, ClassifierContext]>([
    ["a state key", { state: { [CODENAME]: "value" }, questions: {} }],
    [
      "a nested state key",
      { state: { outer: { [CODENAME]: "value" } }, questions: {} },
    ],
    [
      "a question id",
      {
        state: {},
        questions: {
          [CODENAME]: {
            type: "bool",
            instructions: "Is it ready?",
            criteria: { true: "yes", false: "no" },
          },
        },
      },
    ],
    [
      "a choice label",
      {
        state: {},
        questions: {
          pick: {
            type: "choice",
            instructions: "Pick one",
            criteria: { [CODENAME]: "criterion" },
          },
        },
      },
    ],
  ])(
    "rejects a classifier call with %s that masking would change",
    async (_label, context) => {
      const classify = vi.fn();
      const registry = { classify, generateImages: vi.fn() };
      installModelGuard(registry, async (text) =>
        text.replace(CODENAME, "Masked-Value-0001"),
      );

      await expect(
        registry.classify(classifierModel(), context),
      ).rejects.toThrow("BLOCKED: a classifier key would be masked");
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it("masks a secret glued to a word in a classifier call", async () => {
    vi.stubEnv("PROBE_API_TOKEN", "Zq7fakeEnvValue99");
    const pi = fakePi();
    const ctx = testContext();
    const classify = vi.mocked(ctx.modelRegistry.classify);
    startSession(ctx, pi);

    await ctx.modelRegistry.classify(classifierModel(), {
      state: { note: "see build_Zq7fakeEnvValue99" },
      questions: {},
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(JSON.stringify(classify.mock.calls)).not.toContain(
      "Zq7fakeEnvValue99",
    );
  });

  it("masks a configured value shorter than 8 characters glued to a word in a classifier call", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "pin", type: "literal", values: ["Kx-91ab"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    const classify = vi.mocked(ctx.modelRegistry.classify);
    startSession(ctx, pi);

    await ctx.modelRegistry.classify(classifierModel(), {
      state: { note: "see build_Kx-91ab" },
      questions: {},
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(JSON.stringify(classify.mock.calls)).not.toContain("Kx-91ab");
  });

  it("guards a registry once when it is installed twice", async () => {
    const registry = {
      classify: vi.fn(),
      generateImages: vi.fn(),
    };
    const mask = vi.fn(async (text: string) => text);
    installModelGuard(registry, mask);
    installModelGuard(registry, mask);

    await registry
      .classify(classifierModel(), {
        state: { note: "one" },
        questions: {},
      })
      .catch(() => undefined);

    // Keys are masked too, so count only the value's calls.
    expect(mask.mock.calls.filter(([text]) => text === "one")).toHaveLength(1);
  });
});

function assistantMessage(content: AssistantMessage["content"]) {
  return {
    role: "assistant" as const,
    content,
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

function nestedToolResult(text: string) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "codemode",
    content: [{ type: "text" as const, text: "done" }],
    isError: false,
    timestamp: 1,
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: "call-1/1",
          name: "bash",
          arguments: { command: `echo ${text}` },
          status: "error" as const,
          error: `denied ${text}`,
        },
      ],
    },
  };
}

/** Valid base64, so the Google converter keeps it on a same-model replay. */
const GOOGLE_SIGNATURE = Buffer.from("provider-signed-call").toString("base64");

const GOOGLE_MODEL: Model<"google-generative-ai"> = {
  id: "gemini-test",
  name: "Gemini test",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

/** A Google assistant turn with one signed tool call. */
function googleToolCall(command: string): AssistantMessage {
  return {
    ...assistantMessage([
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command },
        thoughtSignature: GOOGLE_SIGNATURE,
      },
    ]),
    api: "google-generative-ai",
    provider: "google",
    model: GOOGLE_MODEL.id,
  };
}

/** The request contents that a same-model Google replay of `message` sends. */
function googleReplay(message: AssistantMessage): string {
  return JSON.stringify(
    convertMessages(GOOGLE_MODEL, normalizeContext({ messages: [message] })),
  );
}

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  };
}

function compactionEvent(
  messages: ReturnType<typeof userMessage>[],
  customInstructions?: string,
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-1",
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
    },
    branchEntries: [],
    customInstructions,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function treeEvent(text: string): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId: "entry-2",
      oldLeafId: "entry-1",
      commonAncestorId: null,
      entriesToSummarize: [
        {
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: userMessage(text),
        },
      ],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  };
}

function toolCallEvent(toolName: string, path: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "1", toolName, input: { path } };
}

function imageModel() {
  return {
    id: "image-model",
    name: "Images",
    api: "openrouter-images" as const,
    provider: "openai",
    baseUrl: "https://example.com",
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    type: "image" as const,
    output: ["image" as const],
  };
}

function classifierModel() {
  return {
    id: "classifier-model",
    name: "Classifier",
    api: "openai-decisions" as const,
    provider: "openai",
    baseUrl: "https://example.com",
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    type: "classifier" as const,
    contextWindow: 1,
  };
}

/** Seven small letters: below the learned-value length and not random-looking, so only a call-local mask covers it. */
const SHORT = "hunterz";
const SHORT_CONFIG = {
  rules: [
    {
      id: "short-password",
      type: "keyed",
      keys: ["password"],
      value: "[A-Za-z0-9]{7}",
    },
  ],
};

/** Masks `password=SHORT` in a provider request and returns the fake that the model sees. */
async function learnShortFake(
  pi: ReturnType<typeof fakePi>,
  ctx: TestContext,
): Promise<string> {
  const masked = maskedContent(
    await pi.handlers.before_provider_request?.(
      providerRequest(`password=${SHORT}`),
      ctx,
    ),
  );
  const fake = /"content":"password=([A-Za-z0-9]+)"/.exec(masked)?.[1];
  if (fake === undefined || fake === SHORT)
    throw new Error("the short value was not masked");
  return fake;
}

function toolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return { type: "tool_call", toolCallId, toolName, input } as ToolCallEvent;
}

function toolResult(
  toolCallId: string,
  fields: Partial<ToolResultEvent>,
): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId,
    toolName: "edit",
    input: {},
    content: [],
    details: undefined,
    isError: false,
    ...fields,
  } as ToolResultEvent;
}

function textOf(text: string): ToolResultEvent["content"] {
  return [{ type: "text", text }];
}

describe("call-local short value remasking", () => {
  beforeEach(() => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
  });

  it("masks a short value in the result of the call that restored it", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    const input = { path: "notes.txt", text: fake };
    await pi.handlers.tool_call?.(toolCall("edit-1", "edit", input), ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT}`) }),
      ctx,
    );

    expect(input.text).toBe(SHORT);
    expect(result).toMatchObject({
      content: [{ type: "text", text: `wrote ${fake}` }],
    });
  });

  it("leaves a short value as written in a call that restored nothing", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("read-1", "read", { path: "other.txt" }),
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      toolResult("read-1", {
        toolName: "read",
        content: textOf(`read ${SHORT}`),
      }),
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: `read ${SHORT}` }],
    });
  });

  it("keeps the restored values of interleaved calls apart", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("edit-1", "edit", { path: "notes.txt", text: fake }),
      ctx,
    );
    await pi.handlers.tool_call?.(
      toolCall("read-1", "read", { path: "other.txt" }),
      ctx,
    );

    const other = await pi.handlers.tool_result?.(
      toolResult("read-1", {
        toolName: "read",
        content: textOf(`read ${SHORT}`),
      }),
      ctx,
    );
    const edited = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT}`) }),
      ctx,
    );

    expect(other).toMatchObject({
      content: [{ type: "text", text: `read ${SHORT}` }],
    });
    expect(edited).toMatchObject({
      content: [{ type: "text", text: `wrote ${fake}` }],
    });
  });

  it("masks a short value inside nested result details and structured content", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("edit-1", "edit", { path: "notes.txt", text: fake }),
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      toolResult("edit-1", {
        content: textOf("done"),
        details: { rows: [{ value: SHORT }] },
        structuredContent: { items: [SHORT] },
      }),
      ctx,
    );

    expect(result).toMatchObject({
      details: { rows: [{ value: fake }] },
      structuredContent: { items: [fake] },
    });
  });

  it("forgets a call's restored values when the call ends without a result", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("edit-1", "edit", { path: "notes.txt", text: fake }),
      ctx,
    );

    pi.handlers.tool_execution_end?.({
      type: "tool_execution_end",
      toolCallId: "edit-1",
      toolName: "edit",
      result: { content: textOf("blocked"), details: {} },
      isError: true,
    } as ToolExecutionEndEvent);
    const result = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT}`) }),
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: `wrote ${SHORT}` }],
    });
  });

  it("forgets a call's restored values when its result masking fails", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("edit-1", "edit", { path: "notes.txt", text: fake }),
      ctx,
    );
    const oversized = await pi.handlers.tool_result?.(
      toolResult("edit-1", {
        content: textOf("done"),
        details: { blob: "x".repeat(PAYLOAD_LIMIT_TEXT_LENGTH) },
      }),
      ctx,
    );

    const retry = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT}`) }),
      ctx,
    );

    expect(oversized).toMatchObject({ content: [{ type: "text" }] });
    expect(retry).toMatchObject({
      content: [{ type: "text", text: `wrote ${SHORT}` }],
    });
  });

  it("forgets a call's restored values on session shutdown", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("edit-1", "edit", { path: "notes.txt", text: fake }),
      ctx,
    );
    await pi.handlers.session_shutdown?.(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    await pi.handlers.session_start?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT}`) }),
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: `wrote ${SHORT}` }],
    });
  });
});

/** Every character of `text` as an upper-case percent escape, so the whole text is one encoded run. */
const percentEachChar = (text: string): string =>
  Array.from(
    text,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  ).join("");

/** Masks the percent-encoded `password=SHORT` in a provider request and returns the encoded fake. */
async function learnEncodedShortFake(
  pi: ReturnType<typeof fakePi>,
  ctx: TestContext,
): Promise<string> {
  const encoded = percentEachChar(`password=${SHORT}`);
  const masked = maskedContent(
    await pi.handlers.before_provider_request?.(providerRequest(encoded), ctx),
  );
  const fake = /"content":"((?:%[0-9A-F]{2})+)"/.exec(masked)?.[1];
  if (fake === undefined || fake === encoded)
    throw new Error("the encoded short value was not masked");
  return fake;
}

describe("call-local encoded short value remasking", () => {
  beforeEach(() => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
  });

  it("masks the decoded short value of a bound encoded fake restored in the same call", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const encodedFake = await learnEncodedShortFake(pi, ctx);
    const fake = await learnShortFake(pi, ctx);
    const input = { path: "notes.txt", text: encodedFake };
    await pi.handlers.tool_call?.(toolCall("edit-1", "edit", input), ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT}`) }),
      ctx,
    );

    expect(input.text).toBe(percentEachChar(`password=${SHORT}`));
    expect(result).toMatchObject({
      content: [{ type: "text", text: `wrote ${fake}` }],
    });
  });

  it("masks only the values that the call restored, not other short vault values", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const encodedFake = await learnEncodedShortFake(pi, ctx);
    const fake = await learnShortFake(pi, ctx);
    const other = "lantern";
    await pi.handlers.before_provider_request?.(
      providerRequest(`password=${other}`),
      ctx,
    );
    await pi.handlers.tool_call?.(
      toolCall("edit-1", "edit", { path: "notes.txt", text: encodedFake }),
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      toolResult("edit-1", { content: textOf(`wrote ${SHORT} and ${other}`) }),
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: `wrote ${fake} and ${other}` }],
    });
  });
});

/** A made-up live key. Its last four characters, `rUcb`, are what `tail -c 4` prints. */
const LIVE_KEY = "sk_live_Qm3vT8pXw2Lk9ZrUcb";

/** Masks the live key in a provider request and returns the fake that the model sees. */
async function liveKeyFake(
  pi: ReturnType<typeof fakePi>,
  ctx: TestContext,
): Promise<string> {
  const masked = maskedContent(
    await pi.handlers.before_provider_request?.(
      providerRequest(`key ${LIVE_KEY}`),
      ctx,
    ),
  );
  const fake = /"content":"key ([^"]+)"/.exec(masked)?.[1];
  if (fake === undefined || fake === LIVE_KEY)
    throw new Error("the live key was not masked");
  return fake;
}

describe("bash output of restored values", () => {
  beforeEach(() => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "live-key", type: "literal", values: [LIVE_KEY] }],
    });
  });

  it("masks the last four characters of a restored value in the bash output", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await liveKeyFake(pi, ctx);
    const input = { command: `printf '%s' '${fake}' | tail -c 4` };
    await pi.handlers.tool_call?.(toolCall("bash-1", "bash", input), ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("bash-1", { toolName: "bash", content: textOf("rUcb") }),
      ctx,
    );
    const shown = /"text":"([^"]*)"/.exec(maskedContent(result))?.[1];
    const restored = { path: "notes.txt", text: shown };
    await pi.handlers.tool_call?.(toolCall("edit-1", "edit", restored), ctx);

    expect(shown).not.toBe("rUcb");
    expect(restored.text).toBe("rUcb");
  });

  it("keeps an unrelated four-character token in the same bash output", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await liveKeyFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("bash-1", "bash", {
        command: `printf '%s' '${fake}'; echo wxyz`,
      }),
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      toolResult("bash-1", {
        toolName: "bash",
        content: textOf("rUcb wxyz"),
      }),
      ctx,
    );
    const shown = /"text":"([^"]*)"/.exec(maskedContent(result))?.[1];

    expect(shown).toMatch(/^[A-Za-z0-9]{4} wxyz$/);
    expect(shown).not.toContain("rUcb");
  });

  it("masks the last four characters that a command read from a file", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await liveKeyFake(pi, ctx);
    const command = `key=$(cat config.yaml); printf '%s' "\${key: -4}"`;
    await pi.handlers.tool_call?.(toolCall("bash-1", "bash", { command }), ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("bash-1", { toolName: "bash", content: textOf("rUcb") }),
      ctx,
    );
    const shown = /"text":"([^"]*)"/.exec(maskedContent(result))?.[1];
    const restored = { path: "notes.txt", text: shown };
    await pi.handlers.tool_call?.(toolCall("edit-1", "edit", restored), ctx);

    expect(shown).not.toBe("rUcb");
    expect(restored.text).toBe("rUcb");
  });
});

const OD_C_CODENAME = [
  "0000000    Q   u   i   l   l   -   H   a   r   b   o   r   -   N   i   n",
  "0000020    e   t   y",
  "0000023",
].join("\n");

describe("split vault value in tool output", () => {
  async function learnCodename(
    pi: ReturnType<typeof fakePi>,
    ctx: TestContext,
  ): Promise<void> {
    await pi.handlers.tool_result?.(
      toolResult("learn", {
        toolName: "bash",
        content: textOf(`codename ${CODENAME}`),
      }),
      ctx,
    );
  }

  it("withholds od -c output that spells a vault value", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("od-1", { toolName: "bash", content: textOf(OD_C_CODENAME) }),
      ctx,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "[MASKED]" }],
      details: "[MASKED]",
    });
    expect(ctx.aborts).toBe(1);
    expect(ctx.notices.map(({ message }) => message)).toContainEqual(
      expect.stringContaining("HIDDEN_REAL"),
    );
  });

  const rot13 = (text: string): string =>
    text.replace(/[a-z]/gi, (char) => {
      const base = char <= "Z" ? 65 : 97;
      return String.fromCharCode(
        ((char.charCodeAt(0) - base + 13) % 26) + base,
      );
    });
  const codes = [...CODENAME].map((char) => char.charCodeAt(0));
  const hex = (code: number): string => code.toString(16).padStart(2, "0");
  const xxd = (text: string): string =>
    (text.match(/.{1,16}/g) ?? [])
      .map((line, index) => {
        const groups = Buffer.from(line)
          .toString("hex")
          .match(/.{1,4}/g);
        const offset = (index * 16).toString(16).padStart(8, "0");
        return `${offset}: ${groups?.join(" ").padEnd(39)}  ${line}`;
      })
      .join("\n");
  const hexdump = (text: string): string =>
    [
      ...(text.match(/.{1,16}/g) ?? []).map((line, index) => {
        const bytes = [...Buffer.from(line)].map(hex);
        const offset = (index * 16).toString(16).padStart(8, "0");
        const columns = `${bytes.slice(0, 8).join(" ")}  ${bytes.slice(8).join(" ")}`;
        return `${offset}  ${columns.padEnd(48)}  |${line}|`;
      }),
      text.length.toString(16).padStart(8, "0"),
    ].join("\n");
  it.each([
    ["reversed", [...CODENAME].reverse().join("")],
    ["rot13", rot13(CODENAME)],
    ["hex", Buffer.from(CODENAME).toString("hex")],
    ["upper hex", Buffer.from(CODENAME).toString("hex").toUpperCase()],
    ["\\u escapes", codes.map((code) => `\\u00${hex(code)}`).join("")],
    ["\\x escapes", codes.map((code) => `\\x${hex(code)}`).join("")],
    ["char codes", codes.join(",")],
    ["comma separated", [...CODENAME].join(",")],
    ["dot separated", [...CODENAME].join(".")],
    ["comma and space separated", [...CODENAME].join(", ")],
    ["one character per line", [...CODENAME].join("\n")],
    ["as xxd prints it", xxd(CODENAME)],
    [
      "as xxd -u prints it",
      xxd(CODENAME).replace(/ [0-9a-f]{2,4}(?= )/g, (group) =>
        group.toUpperCase(),
      ),
    ],
    ["as hexdump -C prints it", hexdump(CODENAME)],
    [
      "in hex after a word that ends in a hex letter",
      `done ${Buffer.from(CODENAME).toString("hex")}`,
    ],
    ["as od -An -tx1 prints it", codes.map(hex).join(" ")],
    [
      "as od -tx1 prints it",
      `\n0000000 ${codes.slice(0, 8).map(hex).join(" ")}\n0000010 ${codes.slice(8).map(hex).join(" ")}`,
    ],
    [
      "reversed in base64",
      Buffer.from([...CODENAME].reverse().join("")).toString("base64"),
    ],
    ["rot13 in base64", Buffer.from(rot13(CODENAME)).toString("base64")],
  ])("withholds output that spells a vault value %s", async (_, output) => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("t-1", { toolName: "bash", content: textOf(`out ${output}`) }),
      ctx,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "[MASKED]" }],
      details: "[MASKED]",
    });
    expect(ctx.aborts).toBe(1);
  });

  it("withholds hexdump -C output that spells a vault value from its first line", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);
    const output = hexdump(`my codename is ${CODENAME} ok`);

    await pi.handlers.tool_result?.(
      toolResult("t-1", { toolName: "bash", content: textOf(output) }),
      ctx,
    );

    expect(ctx.aborts).toBe(1);
  });

  const GITHUB_TOKEN = "ghp_VATh4IXRGeKOgzW5pO0KGKWzXxyMAkXSCsuB";
  /** As `fold -w 10` prints it. */
  const fold = (text: string): string =>
    (text.match(/.{1,10}/g) ?? []).join("\n");
  it.each([
    ["reversed", [...GITHUB_TOKEN].reverse().join("")],
    ["rot13", rot13(GITHUB_TOKEN)],
    ["glued to a word, which masking keeps", `x${GITHUB_TOKEN}`],
    ["one character per line", [...GITHUB_TOKEN].join("\n")],
    ["wrapped at 10 columns", fold(GITHUB_TOKEN)],
    [
      "wrapped at 10 columns with CRLF",
      fold(GITHUB_TOKEN).replace(/\n/g, "\r\n"),
    ],
    [
      "wrapped at 10 columns and indented",
      fold(GITHUB_TOKEN).replace(/^/gm, "  "),
    ],
    [
      "wrapped at 10 columns with trailing blanks",
      fold(GITHUB_TOKEN).replace(/\n/g, " \n"),
    ],
    [
      "wrapped at 10 columns with CR only",
      fold(GITHUB_TOKEN).replace(/\n/g, "\r"),
    ],
    ["as xxd prints it", xxd(GITHUB_TOKEN)],
  ])("withholds a secret seen first %s", async (_, output) => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_result?.(
      toolResult("t-1", { toolName: "bash", content: textOf(output) }),
      ctx,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "[MASKED]" }],
      details: "[MASKED]",
    });
    expect(ctx.aborts).toBe(1);
  });

  it.each([
    ["with CRLF", "\r\n"],
    ["and indented", "\n  "],
  ])(
    "withholds a letters-only literal wrapped at 10 columns %s",
    async (_, wrap) => {
      writeJson(join(projectDir, ".pi", "lmsk.json"), {
        rules: [
          {
            id: "codename",
            type: "literal",
            values: ["QuillHarborNinetyBasalt"],
          },
        ],
      });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const output = fold("QuillHarborNinetyBasalt").replace(/\n/g, wrap);

      const result = await pi.handlers.tool_result?.(
        toolResult("t-1", { toolName: "bash", content: textOf(output) }),
        ctx,
      );

      expect(result).toEqual({
        content: [{ type: "text", text: "[MASKED]" }],
        details: "[MASKED]",
      });
      expect(ctx.aborts).toBe(1);
    },
  );

  it.each([
    ["a masked connection password", "postgres://app:Xy7pQ2wLm9Rt@db:5432/app"],
    ["a version that reads as an email reversed", "bignumber.js@9.3.1"],
    ["hex that decodes to binary", "ee0a7365637265744b6579ac"],
    [
      "a constant that names a Stripe key mode",
      "export const SK_LIVE_ENVIRONMENTS = 1;",
    ],
  ])("passes output with %s", async (_, text) => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.tool_result?.(
      toolResult("t-1", { toolName: "bash", content: textOf(text) }),
      ctx,
    );

    expect(ctx.aborts).toBe(0);
  });

  it("withholds a secret seen first next to a masked value in base64", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const encoded = Buffer.from(`${CODENAME} ${rot13(GITHUB_TOKEN)}`).toString(
      "base64",
    );

    await pi.handlers.tool_result?.(
      toolResult("t-1", { toolName: "bash", content: textOf(encoded) }),
      ctx,
    );

    expect(ctx.aborts).toBe(1);
  });

  it("passes a fake that completes a token rule in its context", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "template", type: "literal", values: ["${VALUE}"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.tool_result?.(
      toolResult("t-1", {
        toolName: "bash",
        content: textOf("curl -u admin:${VALUE} https://api.example.net"),
      }),
      ctx,
    );

    expect(ctx.aborts).toBe(0);
  });

  it("passes a dotted date whose digits are a learned value", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "day", type: "literal", values: ["20241015"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.tool_result?.(
      toolResult("learn-ip", {
        toolName: "bash",
        content: textOf("day 20241015"),
      }),
      ctx,
    );
    const text = "date 2024.10.15";

    const result = await pi.handlers.tool_result?.(
      toolResult("date-1", { toolName: "bash", content: textOf(text) }),
      ctx,
    );

    expect(result).toMatchObject({ content: [{ type: "text", text }] });
    expect(ctx.aborts).toBe(0);
  });

  it("passes output whose words only resemble a vault value", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);
    const output = JSON.stringify([...CODENAME]);

    const result = await pi.handlers.tool_result?.(
      toolResult("t-1", { toolName: "bash", content: textOf(output) }),
      ctx,
    );

    expect(result).toMatchObject({ content: [{ type: "text", text: output }] });
    expect(ctx.aborts).toBe(0);
  });

  it.each([[true], [false]])(
    "masks a vault value glued to a word as its own value with withholdHiddenCopies %s",
    async (withholdHiddenCopies) => {
      writeProjectConfig();
      writeGlobalConfig({ withholdHiddenCopies });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      await learnCodename(pi, ctx);

      const result = await pi.handlers.tool_result?.(
        toolResult("token-1", {
          toolName: "bash",
          content: textOf(`${CODENAME}_v2`),
        }),
        ctx,
      );

      expect(maskedContent(result)).toMatch(/"text":"\w+"/);
      expect(maskedContent(result)).not.toContain(CODENAME);
      expect(ctx.aborts).toBe(0);
    },
  );

  it("masks a configured value shorter than 8 characters glued to a word", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "pin", type: "literal", values: ["Kx-91ab"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_result?.(
      toolResult("t-1", {
        toolName: "bash",
        content: textOf("artifact build_Kx-91ab"),
      }),
      ctx,
    );

    expect(maskedContent(result)).toMatch(/"text":"artifact \w+"/);
    expect(maskedContent(result)).not.toContain("Kx-91ab");
    expect(ctx.aborts).toBe(0);
  });

  it.each([["block"], ["mask"]])(
    "withholds a %s rule value glued to a word",
    async (strategy) => {
      writeJson(join(projectDir, ".pi", "lmsk.json"), {
        rules: [
          { id: "pin", type: "literal", values: ["Kx-91abQQ"], strategy },
        ],
      });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.tool_result?.(
        toolResult("t-1", {
          toolName: "bash",
          content: textOf("artifact build_Kx-91abQQ"),
        }),
        ctx,
      );

      expect(result).toMatchObject({
        content: [{ type: "text", text: "[MASKED]" }],
      });
      expect(ctx.aborts).toBe(1);
    },
  );

  it.each([
    ["1234", "Found 4321 rows"],
    ["Ana", "Nancy wrote this"],
  ])(
    "passes a configured value shorter than 8 characters that only a reversed or rot13 reading shows: %s",
    async (value, text) => {
      writeJson(join(projectDir, ".pi", "lmsk.json"), {
        rules: [{ id: "pin", type: "literal", values: [value] }],
      });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.tool_result?.(
        toolResult("t-1", { toolName: "bash", content: textOf(text) }),
        ctx,
      );

      expect(JSON.stringify(result)).toContain(text);
      expect(ctx.aborts).toBe(0);
    },
  );

  it("passes a wrapped secret seen first when the global config turns the check off", async () => {
    writeGlobalConfig({ withholdHiddenCopies: false });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.handlers.tool_result?.(
      toolResult("t-1", {
        toolName: "bash",
        content: textOf(fold(GITHUB_TOKEN)),
      }),
      ctx,
    );

    expect(ctx.aborts).toBe(0);
  });

  it("passes a hidden copy when the global config turns the check off", async () => {
    writeProjectConfig();
    writeGlobalConfig({ withholdHiddenCopies: false });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);
    const text = [...CODENAME].reverse().join("");

    const result = await pi.handlers.tool_result?.(
      toolResult("token-1", { toolName: "bash", content: textOf(text) }),
      ctx,
    );

    expect(result).not.toMatchObject({
      content: [{ type: "text", text: "[MASKED]" }],
    });
    expect(ctx.aborts).toBe(0);
  });

  it("withholds a prefixed token glued to a word when the global config turns the check off", async () => {
    writeProjectConfig();
    writeGlobalConfig({ withholdHiddenCopies: false });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);

    const result = await pi.handlers.tool_result?.(
      toolResult("token-1", {
        toolName: "bash",
        content: textOf(`x${GITHUB_TOKEN}`),
      }),
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "[MASKED]" }],
    });
    expect(ctx.aborts).toBe(1);
  });

  it("passes od output of a file that holds no vault value", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);
    const od = [
      "0000000    H   e   l   l   o   ,       w   o   r   l   d",
      "0000014",
    ].join("\n");

    const result = await pi.handlers.tool_result?.(
      toolResult("od-2", { toolName: "bash", content: textOf(od) }),
      ctx,
    );

    expect(result).toMatchObject({ content: [{ type: "text", text: od }] });
    expect(ctx.aborts).toBe(0);
  });
});

describe("lmsk command", () => {
  it("reveals the real values of fakes in a text on screen only", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const first = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /codename (\S+?)"/.exec(first)?.[1];

    await pi.commands.lmsk?.(`reveal the project is ${fake}.`, ctx);

    expect(ctx.notices).toEqual([
      { message: `the project is ${CODENAME}.`, level: "info" },
    ]);
  });

  it("reveals the last assistant message of the branch on screen only", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const first = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /codename (\S+?)"/.exec(first)?.[1];
    ctx.sessionManager.getBranch = () => [
      {
        type: "message",
        message: assistantMessage([{ type: "text", text: "old" }]),
      },
      {
        type: "message",
        message: assistantMessage([
          { type: "text", text: `the project is ${fake}.` },
        ]),
      },
      { type: "message", message: userMessage("thanks") },
    ];

    await pi.commands.lmsk?.("reveal", ctx);

    expect(ctx.notices).toEqual([
      { message: `the project is ${CODENAME}.`, level: "info" },
    ]);
  });

  it("reports an error for /lmsk reveal when the branch has no assistant message", async () => {
    const pi = fakePi();
    const ctx = testContext({
      branch: [{ type: "message", message: userMessage("hi") }],
    });
    startSession(ctx, pi);

    await pi.commands.lmsk?.("reveal", ctx);

    expect(ctx.notices).toEqual([
      {
        message: "lmsk: no assistant message on this branch to reveal.",
        level: "error",
      },
    ]);
  });

  it("reports enabled by default, with the history limit and no secret", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.commands.lmsk?.("status", ctx);

    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("enabled"), level: "info" },
    ]);
    expect(ctx.notices[0]?.message).toContain("written while off");
    expect(JSON.stringify(ctx.notices)).not.toContain(CODENAME);
  });

  it("warns on off, reports off, and sends provider payloads unmasked", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.commands.lmsk?.("off", ctx);
    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );
    await pi.commands.lmsk?.("status", ctx);

    expect(ctx.notices[0]).toEqual({
      message: expect.stringContaining(
        "Raw data may reach the provider and disk",
      ),
      level: "warning",
    });
    expect(result).toBeUndefined();
    expect(ctx.aborts).toBe(0);
    expect(ctx.notices.at(-1)).toEqual({
      message: expect.stringMatching(/^lmsk: off\./),
      level: "info",
    });
  });

  it("passes persisted messages and tool results through unmasked when off", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.commands.lmsk?.("off", ctx);

    const message = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: {
          role: "user",
          content: `codename ${CODENAME}`,
          timestamp: 1,
        },
      },
      ctx,
    );
    const result = await pi.handlers.tool_result?.(
      toolResult("call-1", { content: textOf(`codename ${CODENAME}`) }),
      ctx,
    );

    expect(message).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("keeps the protected-path block and the local restore when off", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "codename", type: "literal", values: [CODENAME] }],
      protectedPaths: [`**/${CODENAME}*`],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1] ?? "";
    await pi.commands.lmsk?.("off", ctx);

    const blocked = await pi.handlers.tool_call?.(
      toolCall("1", "read", { path: fake }),
      ctx,
    );
    const input = { path: "notes.txt", text: `codename ${fake}` };
    await pi.handlers.tool_call?.(toolCall("2", "edit", input), ctx);

    expect(blocked).toMatchObject({ block: true });
    expect(input.text).toBe(`codename ${CODENAME}`);
  });

  it("re-enables masking on, and says earlier raw entries stay raw", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.commands.lmsk?.("off", ctx);
    await pi.commands.lmsk?.("on", ctx);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(ctx.notices.at(-1)).toEqual({
      message: expect.stringContaining(
        "does not clean entries written while off",
      ),
      level: "info",
    });
    expect(maskedContent(result)).not.toContain(CODENAME);
  });

  it("refuses off and on while the vault is blocked, and keeps requests blocked", async () => {
    writeProjectConfig();
    const branch = [
      {
        type: "custom",
        customType: VAULT_ENTRY,
        data: { namespaceId: "0".repeat(32) },
      },
    ];
    const pi = fakePi();
    const ctx = testContext({ branch });
    startSession(ctx, pi);
    const startupNotices = ctx.notices.length;

    await pi.commands.lmsk?.("off", ctx);
    await pi.commands.lmsk?.("on", ctx);
    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );
    await pi.commands.lmsk?.("status", ctx);
    await pi.commands.lmsk?.("reveal x", ctx);

    const blocked =
      "lmsk: blocked (STORE_MISSING). /lmsk cannot change masking until the session reloads.";
    expect(ctx.notices.slice(startupNotices)).toEqual([
      { message: blocked, level: "error" },
      { message: blocked, level: "error" },
      {
        message: expect.stringContaining("blocked (STORE_MISSING)"),
        level: "info",
      },
      {
        message:
          "lmsk: blocked (STORE_MISSING). /lmsk reveal needs a working vault.",
        level: "error",
      },
    ]);
    expect(result).toEqual({});
    expect(ctx.aborts).toBe(1);
  });

  it("enables masking again after a session reload", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.commands.lmsk?.("off", ctx);

    await pi.handlers.session_start?.(
      { type: "session_start", reason: "reload" },
      ctx,
    );
    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(CODENAME);
  });

  it("sends compaction and tree summary payloads unmasked while off", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);
    await pi.commands.lmsk?.("off", ctx);

    const compacted = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage(`codename ${CODENAME}`)]),
      ctx,
    );
    const branch = await pi.handlers.session_before_tree?.(
      treeEvent(`codename ${CODENAME}`),
      ctx,
    );

    expect(compacted).toMatchObject({
      compaction: { summary: expect.stringContaining("Keep going") },
    });
    expect(branch).toMatchObject({
      summary: { summary: expect.stringContaining("Keep going") },
    });
    expect(JSON.stringify(provider.bodies)).toContain(CODENAME);
  });

  it("sends model call text unmasked while off, and masks it again when on", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    const classify = vi.mocked(ctx.modelRegistry.classify);
    startSession(ctx, pi);
    const context = { state: { note: `codename ${CODENAME}` }, questions: {} };

    await pi.commands.lmsk?.("off", ctx);
    await ctx.modelRegistry.classify(classifierModel(), context);
    await pi.commands.lmsk?.("on", ctx);
    await ctx.modelRegistry.classify(classifierModel(), context);

    expect(classify.mock.calls[0]?.[1]).toEqual(context);
    expect(JSON.stringify(classify.mock.calls[1]?.[1])).not.toContain(CODENAME);
  });

  it("rejects an unknown argument with the usage line", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.commands.lmsk?.("toggle", ctx);

    expect(ctx.notices).toEqual([
      {
        message: "Usage: /lmsk status|on|off|reveal [text]",
        level: "error",
      },
    ]);
  });
});

describe("case variant of a learned value in tool output", () => {
  it("masks a lowercase copy of a learned account id and restores its spelling", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.tool_result?.(
      toolResult("read-1", {
        toolName: "read",
        content: textOf("account TE1234567"),
      }),
      ctx,
    );

    const result = await pi.handlers.tool_result?.(
      toolResult("bash-1", {
        toolName: "bash",
        content: textOf("branch feature/te1234567-fix"),
      }),
      ctx,
    );
    const shown = /"text":"([^"]*)"/.exec(maskedContent(result))?.[1];
    const restored = { path: "notes.txt", text: shown };
    await pi.handlers.tool_call?.(toolCall("edit-1", "edit", restored), ctx);

    expect(ctx.aborts).toBe(0);
    expect(shown).toMatch(/^branch feature\/\w+-fix$/);
    expect(shown?.toLowerCase()).not.toContain("te1234567");
    expect(restored.text).toBe("branch feature/te1234567-fix");
  });
});
