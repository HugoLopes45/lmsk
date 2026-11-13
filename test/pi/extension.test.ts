import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  createReadTool,
  createSyntheticSourceInfo,
  type BeforeProviderRequestEvent,
  type MessageEndEvent,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type ClassifierContext,
  type Context,
  type ImagesContext,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lmsk from "../../src/pi/extension.ts";
import {
  type GuardedRegistry,
  installModelGuard,
} from "../../src/pi/guard-runtime.ts";
import type { BranchRecord } from "../../src/pi/host.ts";
import { HIDDEN } from "../../src/core/guard.ts";
import { Scanner } from "../../src/core/index.ts";

/** A made-up project codename that no default rule matches, so only a configured rule masks it. */
const CODENAME = "Quill-Harbor-Ninety";
const GITHUB_TOKEN = "ghp_VATh4IXRGeKOgzW5pO0KGKWzXxyMAkXSCsuB";

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
  // The extension keeps its key and vault under XDG_STATE_HOME, so a test must not reach the user's.
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
});

afterEach(() => {
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
  modelRegistry: GuardedRegistry;
  aborts: number;
  notices: Notice[];
}

const GLUED_NOTICE = {
  message:
    "lmsk: HIDDEN_REAL. A secret glued to a word is in the conversation or a context file. Use /tree to go back before it without a summary, start a new session, or remove it from the context file.",
  level: "error",
};

/** Stands in for the provider calls of the registry: each runs `onPayload` as the transport does, then answers. */
type ProviderStub = Pick<
  GuardedRegistry,
  "stream" | "streamSimple" | "complete"
> & {
  /** Request bodies that reached the provider, after the masking hook ran. */
  bodies: unknown[];
};

function providerStub(
  reply: { text: string; stopReason?: "stop" | "length" | "error" } = {
    text: "## Goal\nKeep going",
  },
): ProviderStub {
  const bodies: unknown[] = [];
  const send = async (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ): Promise<AssistantMessage> => {
    const body = (await options?.onPayload?.(context, model)) ?? context;
    bodies.push(body);
    return {
      ...assistantMessage([{ type: "text", text: reply.text }]),
      stopReason: reply.stopReason ?? "stop",
    };
  };
  // As in pi-ai, a failure before the request ends the stream with an error result.
  const stream = (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ) => {
    const events = createAssistantMessageEventStream();
    void send(model, context, options).then(
      (message) => events.end(message),
      (error: unknown) =>
        events.end({
          ...assistantMessage([]),
          stopReason: "error",
          errorMessage: String(error),
        }),
    );
    return events;
  };
  return {
    bodies,
    stream,
    streamSimple: stream,
    complete: (model, context, options) =>
      stream(model, context, options).result(),
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
      stream: provider.stream,
      streamSimple: provider.streamSimple,
      complete: provider.complete,
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
function fakePi(options: { tools?: ToolSource[] } = {}) {
  const handlers: {
    session_start?: (event: SessionStartEvent, ctx: TestContext) => unknown;
    before_provider_request?: (
      event: BeforeProviderRequestEvent,
      ctx: TestContext,
    ) => unknown;
    tool_call?: (event: ToolCallEvent, ctx: TestContext) => unknown;
    message_end?: (event: MessageEndEvent, ctx: TestContext) => unknown;
    session_before_compact?: (
      event: SessionBeforeCompactEvent,
      ctx: TestContext,
    ) => unknown;
    session_before_tree?: (
      event: SessionBeforeTreeEvent,
      ctx: TestContext,
    ) => unknown;
    session_shutdown?: (
      event: SessionShutdownEvent,
      ctx: TestContext,
    ) => unknown;
  } = {};
  const commands: Record<
    string,
    (args: string, ctx: TestContext) => Promise<void>
  > = {};
  return {
    handlers,
    commands,
    pi: {
      on(event: keyof typeof handlers, handler: never) {
        handlers[event] = handler;
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
  ])("masks %s glued to a word as its own value", async (_, secret) => {
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

    expect(maskedContent(result)).toContain("see build_");
    expect(maskedContent(result)).not.toContain(secret);
    expect(ctx.aborts).toBe(0);
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

  it("masks every segment of a default match that a project rule overlaps", async () => {
    // Built at run time, so no JWT literal is in the file.
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(text),
      ctx,
    );

    const out = JSON.stringify(result);
    expect(out).toContain("Authorization: ");
    for (const segment of jwt.split(".")) expect(out).not.toContain(segment);
  });

  it("notifies with the way out on every request blocked for a glued secret", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const request = providerRequest(`see x${GITHUB_TOKEN}`);

    await pi.handlers.before_provider_request?.(request, ctx);
    await pi.handlers.before_provider_request?.(request, ctx);

    expect(ctx.aborts).toBe(2);
    expect(ctx.notices).toEqual([GLUED_NOTICE, GLUED_NOTICE]);
  });

  it("blocks each request for a glued secret when the notice throws", async () => {
    const pi = fakePi();
    const ctx = testContext();
    ctx.ui.notify = () => {
      throw new Error("ui broken");
    };
    startSession(ctx, pi);
    const request = providerRequest(`see x${GITHUB_TOKEN}`);

    const first = await pi.handlers.before_provider_request?.(request, ctx);
    const second = await pi.handlers.before_provider_request?.(request, ctx);

    expect([first, second]).toEqual([{}, {}]);
    expect(ctx.aborts).toBe(2);
  });

  it("blocks a request for a glued secret when the abort throws", async () => {
    const pi = fakePi();
    const ctx = testContext();
    ctx.abort = () => {
      throw new Error("ctx stale");
    };
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`see x${GITHUB_TOKEN}`),
      ctx,
    );

    expect(result).toEqual({});
  });

  it("masks a value glued in the history once a later output teaches it", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const history = { role: "user", content: "see build_Xk9-pL2q-Wm7z" };
    const output = { role: "tool", content: 'password: "Xk9-pL2q-Wm7z"' };

    const first = await pi.handlers.before_provider_request?.(
      { type: "before_provider_request", payload: { messages: [history] } },
      ctx,
    );
    const second = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { messages: [history, output] },
      },
      ctx,
    );

    expect(maskedContent(first)).toContain("build_Xk9-pL2q-Wm7z");
    expect(maskedContent(second)).not.toContain("Xk9-pL2q-Wm7z");
    expect(ctx.aborts).toBe(0);
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

  it("blocks every provider request when the config restores powershell, which pi never restores", async () => {
    writeGlobalConfig({ restoredTools: ["powershell"] });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("plain text"),
      ctx,
    );

    expect(result).toEqual({});
    expect(ctx.aborts).toBe(1);
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
    const output = {
      role: "tool",
      tool_call_id: "1",
      content: "@acmecorpcode/ui\nAcmeCorpTheme\nACMECORP\nAcme Corp",
    };
    const result = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: { messages: [question, output] },
      },
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
      messages: [
        {},
        { content: "@client1code/ui\nClient1Theme\nCLIENT1\nClient 1" },
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
});

describe("real values in the session", () => {
  async function learnFake(
    pi: ReturnType<typeof fakePi>,
    ctx: TestContext,
  ): Promise<string> {
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];
    if (fake === undefined || fake === CODENAME)
      throw new Error("the codename was not masked");
    return fake;
  }

  function messageEnd(content: AssistantMessage["content"]): MessageEndEvent {
    return { type: "message_end", message: assistantMessage(content) };
  }

  it("gives the session the real of a learned fake in assistant text, and keeps signed thinking as written", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnFake(pi, ctx);

    const result = await pi.handlers.message_end?.(
      messageEnd([
        { type: "text", text: `codename ${fake}` },
        { type: "thinking", thinking: fake, thinkingSignature: "sig" },
      ]),
      ctx,
    );

    expect(result).toMatchObject({
      message: {
        content: [
          { type: "text", text: `codename ${CODENAME}` },
          { type: "thinking", thinking: fake, thinkingSignature: "sig" },
        ],
      },
    });
  });

  it("keeps the fake of a short real in assistant text, which a later request could not mask again", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);

    const result = await pi.handlers.message_end?.(
      messageEnd([{ type: "text", text: `it is ${fake}` }]),
      ctx,
    );

    expect(result).toMatchObject({
      message: { content: [{ type: "text", text: `it is ${fake}` }] },
    });
  });

  it("gives the session the arguments that each tool call runs with", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnFake(pi, ctx);

    const result = await pi.handlers.message_end?.(
      messageEnd([
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: `${fake}.txt` },
        },
        {
          type: "toolCall",
          id: "call-2",
          name: "mcp__notes__search",
          arguments: { query: fake },
        },
      ]),
      ctx,
    );

    expect(result).toMatchObject({
      message: {
        content: [
          { arguments: { path: `${CODENAME}.txt` } },
          { arguments: { query: fake } },
        ],
      },
    });
  });

  it("sends the restored arguments of a tool call as the fakes that the model wrote", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    const written = { command: `echo ${fake}` };
    const result = await pi.handlers.message_end?.(
      messageEnd([
        { type: "toolCall", id: "call-1", name: "bash", arguments: written },
      ]),
      ctx,
    );
    const restored = JSON.stringify(result);

    const payload = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: {
          messages: [
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: `echo ${SHORT}` }),
                  },
                },
              ],
            },
          ],
        },
      },
      ctx,
    );

    expect(restored).toContain(`echo ${SHORT}`);
    expect(payload).toEqual({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              function: { name: "bash", arguments: JSON.stringify(written) },
            },
          ],
        },
      ],
    });
  });

  it("masks a call's short restored real in a request whose payload leaves out the call ids", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
    const pi = fakePi();
    const branch: BranchRecord[] = [];
    const ctx = testContext({ branch });
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      toolCall("call-1|fc_1", "bash", { command: `echo ${fake}` }),
      ctx,
    );
    branch.push({
      type: "message",
      message: assistantMessage([
        { type: "toolCall", id: "call-1|fc_1", name: "bash", arguments: {} },
      ]),
    });

    const payload = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: {
          contents: [{ role: "user", parts: [{ text: `got ${SHORT}` }] }],
        },
      },
      ctx,
    );

    expect(JSON.stringify(payload)).toContain("got ");
    expect(JSON.stringify(payload)).not.toContain(SHORT);
    expect(ctx.aborts).toBe(0);
  });

  it("masks a short real that a nested call restored, in a request that holds the id of the call that the model made", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const fake = await learnShortFake(pi, ctx);
    await pi.handlers.tool_call?.(
      {
        type: "tool_call",
        toolCallId: "root/1/2",
        parentToolCallId: "root/1",
        toolName: "bash",
        input: { command: `echo ${fake}` },
      },
      ctx,
    );

    const payload = await pi.handlers.before_provider_request?.(
      {
        type: "before_provider_request",
        payload: {
          messages: [
            { role: "tool", tool_call_id: "root", content: `got ${SHORT}` },
          ],
        },
      },
      ctx,
    );

    expect(JSON.stringify(payload)).toContain("got ");
    expect(JSON.stringify(payload)).not.toContain(SHORT);
    expect(ctx.aborts).toBe(0);
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

  it.each([
    [
      "compaction",
      (pi: ReturnType<typeof fakePi>, ctx: TestContext) =>
        pi.handlers.session_before_compact?.(
          compactionEvent([userMessage(`got ${SHORT}`)]),
          ctx,
        ),
    ],
    [
      "branch summary",
      (pi: ReturnType<typeof fakePi>, ctx: TestContext) =>
        pi.handlers.session_before_tree?.(treeEvent(`got ${SHORT}`), ctx),
    ],
    [
      "registry",
      (_pi: ReturnType<typeof fakePi>, ctx: TestContext) =>
        ctx.modelRegistry
          .streamSimple(chatModel(), {
            messages: [userMessage(`got ${SHORT}`)],
          })
          .result(),
    ],
  ])(
    "masks a call's short restored real in the %s request",
    async (_, summarize) => {
      writeJson(join(projectDir, ".pi", "lmsk.json"), SHORT_CONFIG);
      const pi = fakePi();
      const provider = providerStub();
      const branch: BranchRecord[] = [];
      const ctx = testContext({ provider, branch });
      startSession(ctx, pi);
      const fake = await learnShortFake(pi, ctx);
      await pi.handlers.tool_call?.(
        toolCall("call-1", "bash", { command: `echo ${fake}` }),
        ctx,
      );
      branch.push({
        type: "message",
        message: assistantMessage([
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        ]),
      });

      await summarize(pi, ctx);

      expect(provider.bodies).toHaveLength(1);
      expect(JSON.stringify(provider.bodies)).not.toContain(SHORT);
    },
  );

  it("saves both summaries with the real values of the fakes in the replies", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const reply = { text: "" };
    const ctx = testContext({ provider: providerStub(reply) });
    startSession(ctx, pi);
    const masked = maskedContent(
      await pi.handlers.before_provider_request?.(
        providerRequest(`codename ${CODENAME}`),
        ctx,
      ),
    );
    const fake = /"content":"codename ([^"]+)"/.exec(masked)?.[1];
    if (fake === undefined || fake === CODENAME)
      throw new Error("the codename was not masked");
    reply.text = `kept ${fake}`;

    const results = [
      await pi.handlers.session_before_compact?.(
        compactionEvent([userMessage("plain")]),
        ctx,
      ),
      await pi.handlers.session_before_tree?.(treeEvent("plain"), ctx),
    ];

    expect(results).toMatchObject([
      { compaction: { summary: expect.stringContaining(`kept ${CODENAME}`) } },
      { summary: { summary: expect.stringContaining(`kept ${CODENAME}`) } },
    ]);
    expect(JSON.stringify(results)).not.toContain(fake);
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
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_compact?.(
      compactionEvent([userMessage(`see x${GITHUB_TOKEN}`)]),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
    expect(provider.bodies).toEqual([]);
  });

  it("cancels the branch summary without a provider request when the branch holds a secret glued to a word", async () => {
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const result = await pi.handlers.session_before_tree?.(
      treeEvent(`see x${GITHUB_TOKEN}`),
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
  it.each(["read", "grep", "find", "ls", "write", "edit"] as const)(
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
    ["grep", () => ({ pattern: "x", path: root })],
    ["grep", () => ({ pattern: "x", path: join(root, "state") })],
    ["find", () => ({ pattern: "*", path: join(root, "state", "lmsk") })],
    ["grep", () => ({ pattern: "x" })],
    ["find", () => ({ pattern: "*" })],
    ["ls", () => ({ path: root })],
    ["ls", () => ({})],
  ] as const)(
    "blocks %s on a folder that holds the machine state",
    async (toolName, input) => {
      const pi = fakePi();
      const ctx = testContext({ cwd: root });
      startSession(ctx, pi);

      const result = await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName, input: input() },
        ctx,
      );

      expect(result).toMatchObject({ block: true });
    },
  );

  it.each([
    ["grep", () => ({ pattern: "x", path: projectDir })],
    ["grep", () => ({ pattern: "x", path: join(root, "sta") })],
    ["find", () => ({ pattern: "*" })],
    ["ls", () => ({})],
  ] as const)(
    "lets %s search a folder without protected files",
    async (toolName, input) => {
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName, input: input() },
        ctx,
      );

      expect(result).toBeUndefined();
    },
  );

  it.each(["key", "vault.jsonl"])(
    "blocks a read of the machine %s",
    async (file) => {
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.tool_call?.(
        toolCallEvent("read", join(root, "state", "lmsk", file)),
        ctx,
      );

      expect(result).toMatchObject({ block: true });
    },
  );

  it.each([
    ["a path", (file: string) => `od -c ${file}`],
    ["a quoted path", (file: string) => `cat "${file}"`],
    ["a redirect", (file: string) => `echo x>${file}`],
  ])(
    "blocks a bash command that names the machine key in %s",
    async (_, command) => {
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const input = { command: command(join(root, "state", "lmsk", "key")) };

      const result = await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName: "bash", input },
        ctx,
      );

      expect(result).toMatchObject({ block: true });
    },
  );

  it.each(["$HOME", "${HOME}", "~"])(
    "blocks a bash command that names a protected path from %s",
    async (home) => {
      vi.stubEnv("HOME", root);
      writeJson(join(projectDir, ".pi", "lmsk.json"), {
        protectedPaths: [`${root}/keys/**`],
      });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);
      const input = { command: `cat ${home}/keys/a.txt` };

      const result = await pi.handlers.tool_call?.(
        { type: "tool_call", toolCallId: "1", toolName: "bash", input },
        ctx,
      );

      expect(result).toMatchObject({ block: true });
    },
  );

  it("blocks a bash command whose fake word restores to a protected path", async () => {
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
    const command = `cat ${fake ?? ""}`;
    const input = { command };

    const result = await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input },
      ctx,
    );

    expect(fake).toBeDefined();
    expect(result).toEqual({ block: true, reason: "protected path" });
    expect(input.command).toBe(command);
  });

  it("keeps the fakes of a bash call in the assistant message when its restored word is a protected path", async () => {
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

    const result = await pi.handlers.message_end?.(
      {
        type: "message_end",
        message: assistantMessage([
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: `cat ${fake}` },
          },
        ]),
      },
      ctx,
    );

    expect(fake).not.toBe("");
    expect(result).toMatchObject({
      message: {
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: `cat ${fake}` },
          },
        ],
      },
    });
  });

  it("blocks a powershell command that names a protected path", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const input = { command: "Get-Content .env" };

    const result = await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "powershell", input },
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "protected path" });
  });

  it("blocks a write on a protected path when pi does not list the tool as built in", async () => {
    const pi = fakePi({ tools: [] });
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.tool_call?.(
      toolCallEvent("write", ".env.local"),
      ctx,
    );

    expect(result).toMatchObject({ block: true });
  });

  it("runs a bash command that names no protected path", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    const input = { command: "ls src && cat package.json" };

    const result = await pi.handlers.tool_call?.(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input },
      ctx,
    );

    expect(result).toBeUndefined();
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
      ...providerStub(),
    };
    const mask = vi.fn(async (text: string) =>
      text.replace(CODENAME, "Masked-Value-0001"),
    );
    installModelGuard(registry, mask, vi.fn());

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
      const registry = {
        classify,
        generateImages: vi.fn(),
        ...providerStub(),
      };
      installModelGuard(
        registry,
        async (text) => text.replace(CODENAME, "Masked-Value-0001"),
        vi.fn(),
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

  it.each<
    [
      string,
      (
        registry: GuardedRegistry,
        context: Context,
      ) => Promise<AssistantMessage>,
    ]
  >([
    [
      "stream",
      (registry, context) => registry.stream(chatModel(), context).result(),
    ],
    [
      "streamSimple",
      (registry, context) =>
        registry.streamSimple(chatModel(), context).result(),
    ],
    [
      "complete",
      (registry, context) => registry.complete(chatModel(), context),
    ],
  ])(
    "masks the payload of a %s call that another extension makes through the registry",
    async (_method, call) => {
      writeProjectConfig();
      const pi = fakePi();
      const provider = providerStub();
      const ctx = testContext({ provider });
      startSession(ctx, pi);

      await call(ctx.modelRegistry, {
        messages: [userMessage(`codename ${CODENAME}`)],
      });

      expect(provider.bodies).toHaveLength(1);
      expect(JSON.stringify(provider.bodies)).not.toContain(CODENAME);
    },
  );

  it("masks what the caller's onPayload adds to a registry call", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    await ctx.modelRegistry
      .streamSimple(
        chatModel(),
        { messages: [userMessage("plain")] },
        {
          onPayload: () => ({
            messages: [userMessage(`codename ${CODENAME}`)],
          }),
        },
      )
      .result();

    expect(JSON.stringify(provider.bodies)).toContain("codename ");
    expect(JSON.stringify(provider.bodies)).not.toContain(CODENAME);
  });

  it("sends no registry request when masking its payload fails", async () => {
    const pi = fakePi();
    const provider = providerStub();
    const ctx = testContext({ provider });
    startSession(ctx, pi);

    const result = await ctx.modelRegistry
      .streamSimple(chatModel(), {
        messages: [userMessage(`see x${GITHUB_TOKEN}`)],
      })
      .result();

    expect(provider.bodies).toEqual([]);
    expect(result.errorMessage).toContain("HIDDEN_REAL");
  });

  it("guards a registry once when it is installed twice", async () => {
    const registry = {
      classify: vi.fn(),
      generateImages: vi.fn(),
      ...providerStub(),
    };
    const mask = vi.fn(async (text: string) => text);
    const maskPayload = vi.fn(async (payload: unknown) => payload);
    installModelGuard(registry, mask, maskPayload);
    installModelGuard(registry, mask, maskPayload);

    await registry
      .classify(classifierModel(), {
        state: { note: "one" },
        questions: {},
      })
      .catch(() => undefined);
    await registry.streamSimple(chatModel(), { messages: [] }).result();

    // Keys are masked too, so count only the value's calls.
    expect(mask.mock.calls.filter(([text]) => text === "one")).toHaveLength(1);
    expect(maskPayload).toHaveBeenCalledOnce();
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

function chatModel() {
  return {
    id: "chat-model",
    name: "Chat",
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl: "https://example.com",
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1,
    maxTokens: 1,
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
    await pi.handlers.before_provider_request?.(
      providerRequest(`codename ${CODENAME}`),
      ctx,
    );
  }

  it("withholds od -c output that spells a vault value", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(OD_C_CODENAME),
      ctx,
    );

    expect(result).toEqual(providerRequest(HIDDEN).payload);
    expect(ctx.aborts).toBe(0);
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`out ${output}`),
      ctx,
    );

    expect(result).toEqual(providerRequest(HIDDEN).payload);
    expect(ctx.aborts).toBe(0);
  });

  it("withholds hexdump -C output that spells a vault value from its first line", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);
    const output = hexdump(`my codename is ${CODENAME} ok`);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(output),
      ctx,
    );

    expect(result).toEqual(providerRequest(HIDDEN).payload);
  });

  /** As `fold -w 10` prints it. */
  const fold = (text: string): string =>
    (text.match(/.{1,10}/g) ?? []).join("\n");
  it.each([
    ["reversed", [...GITHUB_TOKEN].reverse().join("")],
    ["rot13", rot13(GITHUB_TOKEN)],
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(output),
      ctx,
    );

    expect(result).toEqual(providerRequest(HIDDEN).payload);
    expect(ctx.aborts).toBe(0);
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

      const result = await pi.handlers.before_provider_request?.(
        providerRequest(output),
        ctx,
      );

      expect(result).toEqual(providerRequest(HIDDEN).payload);
      expect(ctx.aborts).toBe(0);
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(text),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(HIDDEN);
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(encoded),
      ctx,
    );

    expect(result).toEqual(providerRequest(HIDDEN).payload);
  });

  it("passes a fake that completes a token rule in its context", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "template", type: "literal", values: ["${VALUE}"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("curl -u admin:${VALUE} https://api.example.net"),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(HIDDEN);
    expect(ctx.aborts).toBe(0);
  });

  it("passes a dotted date whose digits are a learned value", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), {
      rules: [{ id: "day", type: "literal", values: ["20241015"] }],
    });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.before_provider_request?.(
      providerRequest("day 20241015"),
      ctx,
    );
    const text = "date 2024.10.15";

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(text),
      ctx,
    );

    expect(result).toEqual(providerRequest(text).payload);
    expect(ctx.aborts).toBe(0);
  });

  it("passes output whose words only resemble a vault value", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);
    const output = JSON.stringify([...CODENAME]);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(output),
      ctx,
    );

    expect(result).toEqual(providerRequest(output).payload);
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

      const result = await pi.handlers.before_provider_request?.(
        providerRequest(`${CODENAME}_v2`),
        ctx,
      );

      expect(maskedContent(result)).toMatch(/"content":"\w+"/);
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("artifact build_Kx-91ab"),
      ctx,
    );

    expect(maskedContent(result)).toMatch(/"content":"artifact \w+"/);
    expect(maskedContent(result)).not.toContain("Kx-91ab");
    expect(ctx.aborts).toBe(0);
  });

  it.each([["block"], ["mask"]])(
    "blocks a request that holds a %s rule value glued to a word",
    async (strategy) => {
      writeJson(join(projectDir, ".pi", "lmsk.json"), {
        rules: [
          { id: "pin", type: "literal", values: ["Kx-91abQQ"], strategy },
        ],
      });
      const pi = fakePi();
      const ctx = testContext();
      startSession(ctx, pi);

      const result = await pi.handlers.before_provider_request?.(
        providerRequest("artifact build_Kx-91abQQ"),
        ctx,
      );

      expect(result).toEqual({});
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

      const result = await pi.handlers.before_provider_request?.(
        providerRequest(text),
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(fold(GITHUB_TOKEN)),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(HIDDEN);
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(text),
      ctx,
    );

    expect(maskedContent(result)).not.toContain(HIDDEN);
    expect(ctx.aborts).toBe(0);
  });

  it("blocks a request that holds a prefixed token glued to a word when the global config turns the check off", async () => {
    writeProjectConfig();
    writeGlobalConfig({ withholdHiddenCopies: false });
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await learnCodename(pi, ctx);

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(`x${GITHUB_TOKEN}`),
      ctx,
    );

    expect(result).toEqual({});
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

    const result = await pi.handlers.before_provider_request?.(
      providerRequest(od),
      ctx,
    );

    expect(result).toEqual(providerRequest(od).payload);
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

  it("reports enabled by default, with no secret", async () => {
    writeProjectConfig();
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);

    await pi.commands.lmsk?.("status", ctx);

    expect(ctx.notices).toEqual([
      { message: expect.stringContaining("enabled"), level: "info" },
    ]);
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
      message: expect.stringContaining("The provider gets real values"),
      level: "warning",
    });
    expect(result).toBeUndefined();
    expect(ctx.aborts).toBe(0);
    expect(ctx.notices.at(-1)).toEqual({
      message: expect.stringMatching(/^lmsk: off\./),
      level: "info",
    });
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

  it("re-enables masking on, and masks the next request", async () => {
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
      message: expect.stringContaining("enabled"),
      level: "info",
    });
    expect(maskedContent(result)).not.toContain(CODENAME);
  });

  it("refuses off and on while the guard is blocked, and keeps requests blocked", async () => {
    writeJson(join(projectDir, ".pi", "lmsk.json"), { rules: "bad" });
    const pi = fakePi();
    const ctx = testContext();
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
      "lmsk: blocked (CONFIG_INVALID). /lmsk cannot change masking until the session reloads.";
    expect(ctx.notices.slice(startupNotices)).toEqual([
      { message: blocked, level: "error" },
      { message: blocked, level: "error" },
      {
        message: expect.stringContaining("blocked (CONFIG_INVALID)"),
        level: "info",
      },
      {
        message:
          "lmsk: blocked (CONFIG_INVALID). /lmsk reveal needs a working vault.",
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

describe("case variant of a learned value", () => {
  it("masks a lowercase copy of a learned account id and restores its spelling", async () => {
    const pi = fakePi();
    const ctx = testContext();
    startSession(ctx, pi);
    await pi.handlers.before_provider_request?.(
      providerRequest("account TE1234567"),
      ctx,
    );

    const result = await pi.handlers.before_provider_request?.(
      providerRequest("branch feature/te1234567-fix"),
      ctx,
    );
    const shown = /"content":"([^"]*)"/.exec(maskedContent(result))?.[1];
    const restored = { path: "notes.txt", text: shown };
    await pi.handlers.tool_call?.(toolCall("edit-1", "edit", restored), ctx);

    expect(ctx.aborts).toBe(0);
    expect(shown).toMatch(/^branch feature\/\w+-fix$/);
    expect(shown?.toLowerCase()).not.toContain("te1234567");
    expect(restored.text).toBe("branch feature/te1234567-fix");
  });
});
