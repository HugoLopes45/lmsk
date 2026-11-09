import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ProviderConfig,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** One scripted provider reply: assistant text, or one tool call. */
type ContentReply =
  { text: string } | { tool: string; args: Record<string, unknown> };
export type Reply = (
  ContentReply | { error: number; message?: string } | { disconnect: true }
) & { delayMs?: number };

const PROVIDER_TIMEOUT_MS = 5000;
const CLI_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 1000;
const RETRY_DELAY_MS = 1;
const MAX_RETRIES = 1;
let harnessActive = false;
interface PrintRun {
  child: ChildProcess;
  closed: Promise<void>;
}

async function deadline<T>(
  work: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopPrints(runs: Set<PrintRun>): Promise<void> {
  const pending = [...runs];
  for (const { child } of pending) {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      !child.kill("SIGKILL")
    )
      throw new Error("Could not terminate owned CLI child");
  }
  await deadline(
    Promise.all(pending.map((run) => run.closed)),
    SHUTDOWN_TIMEOUT_MS,
    "CLI shutdown",
  );
}
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** A local OpenAI-compatible server. It records each raw request body. */
export interface FakeProvider {
  url: string;
  bodies: string[];
  replies: Reply[];
  close(): Promise<void>;
  waitForRequests(count: number): Promise<void>;
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  const choice = { index: 0, delta, finish_reason: finish };
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [choice] })}\n\n`;
}

function sse(reply: ContentReply | undefined): string {
  if (!reply || "text" in reply)
    return (
      chunk({ role: "assistant", content: reply?.text ?? "done" }, null) +
      chunk({}, "stop") +
      "data: [DONE]\n\n"
    );
  const call = {
    index: 0,
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
  };
  return (
    chunk({ role: "assistant", tool_calls: [call] }, null) +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n"
  );
}

function respond(response: ServerResponse, reply: Reply | undefined): void {
  if (reply && "disconnect" in reply) {
    response.destroy();
    return;
  }
  if (reply && "error" in reply) {
    response.writeHead(reply.error, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: reply.message ?? "Injected provider failure" },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(sse(reply));
}

export async function fakeProvider(
  limits = { requestBytes: MAX_REQUEST_BYTES, captureBytes: MAX_CAPTURE_BYTES },
): Promise<FakeProvider> {
  if (
    ![limits.requestBytes, limits.captureBytes].every(
      (limit) => Number.isSafeInteger(limit) && limit > 0,
    )
  )
    throw new Error("Invalid capture limits");
  const bodies: string[] = [];
  const replies: Reply[] = [];
  const events = new EventEmitter();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let capturedBytes = 0;
  let completedRequests = 0;
  let pendingRequests = 0;
  let captureFailed = false;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    pendingRequests += 1;
    const index = bodies.push("") - 1;
    const decoder = new StringDecoder("utf8");
    let size = 0;
    request.on("error", () => {
      captureFailed = true;
    });
    request.on("close", () => {
      if (!request.complete) captureFailed = true;
    });
    request.on("data", (part: Buffer) => {
      size += part.length;
      capturedBytes += part.length;
      if (size > limits.requestBytes || capturedBytes > limits.captureBytes) {
        captureFailed = true;
        request.destroy();
      } else bodies[index] += decoder.write(part);
    });
    request.on("end", () => {
      bodies[index] += decoder.end();
      completedRequests += 1;
      pendingRequests -= 1;
      events.emit("capture");
      const reply = replies.shift();
      const timer = setTimeout(() => {
        timers.delete(timer);
        respond(response, reply);
      }, reply?.delayMs ?? 0);
      timers.add(timer);
      response.on("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    });
  });
  server.requestTimeout = PROVIDER_TIMEOUT_MS;
  server.headersTimeout = PROVIDER_TIMEOUT_MS;
  server.setTimeout(PROVIDER_TIMEOUT_MS, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    replies,
    waitForRequests: (count) =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          events.removeListener("capture", check);
          events.removeListener("closed", closed);
        };
        const check = () => {
          if (completedRequests >= count) {
            cleanup();
            resolve();
          }
        };
        const closed = () => {
          cleanup();
          reject(new Error("Provider closed before capture"));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Request capture timed out"));
        }, PROVIDER_TIMEOUT_MS);
        events.on("capture", check);
        events.on("closed", closed);
        if (closing) closed();
        else check();
      }),
    close: () => {
      if (closing) return closing;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      events.emit("closed");
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else if (captureFailed || pendingRequests > 0)
            reject(new Error("Provider capture incomplete or limit exceeded"));
          else resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export interface Harness {
  session: AgentSession;
  provider: FakeProvider;
  cwd: string;
  agentDir: string;
  /** Every byte sent to the provider, joined. */
  sent(): string;
  print(args: string[]): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  extensions: ExtensionFactory[];
  /** Absolute path of the extension entrypoint to load. */
  entrypoint?: string;
  trusted?: boolean;
  retry?: boolean;
  /** Files to write under the project directory, by relative path. */
  files?: Record<string, string>;
  /** Global config to write under the agent directory. */
  globalConfig?: string;
  /** Writes the session to a JSONL file under the temporary root instead of memory. */
  persist?: boolean;
}

async function printSession(
  cwd: string,
  agentDir: string,
  providerPath: string,
  entrypoint: string | undefined,
  args: string[],
  runs: Set<PrintRun>,
): Promise<void> {
  if (!entrypoint)
    throw new Error("INTEGRATION_BLOCKED: print requires an entrypoint");
  const cli = fileURLToPath(
    new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  let run: PrintRun | undefined;
  try {
    const execution = promisify(execFile)(
      process.execPath,
      [
        cli,
        "--print",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-mcp",
        "--no-tools",
        "--provider",
        "fake",
        "--model",
        "m",
        "--thinking",
        "off",
        "-e",
        providerPath,
        "-e",
        entrypoint,
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        timeout: CLI_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      },
    );
    run = {
      child: execution.child,
      closed: new Promise<void>((resolve) => {
        execution.child.once("close", resolve);
      }),
    };
    runs.add(run);
    execution.child.stdin?.end();
    await execution;
  } catch {
    throw new Error(
      "CLI failed or exceeded its time/output budget; raw output withheld",
    );
  } finally {
    if (run) runs.delete(run);
  }
}

async function closeHarness(
  session: AgentSession | undefined,
  provider: FakeProvider,
  restoreAgentDir: () => void,
  runs: Set<PrintRun>,
): Promise<void> {
  try {
    session?.agent.abort();
    try {
      await stopPrints(runs);
    } finally {
      await deadline(
        session?.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        }) ?? Promise.resolve(),
        SHUTDOWN_TIMEOUT_MS,
        "Extension shutdown",
      );
    }
  } finally {
    try {
      session?.dispose();
    } finally {
      try {
        await provider.close();
      } finally {
        restoreAgentDir();
      }
    }
  }
}

function writeFixtures(
  cwd: string,
  agentDir: string,
  options: HarnessOptions,
): void {
  for (const [path, text] of Object.entries(options.files ?? {})) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
      throw new Error("Fixture path escapes project");
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  if (options.globalConfig !== undefined) {
    mkdirSync(join(agentDir, "lmsk"));
    writeFileSync(
      join(agentDir, "lmsk", "config.json"),
      options.globalConfig,
    );
  }
}

/** A real pi session in temp directories, wired to a local fake provider. */
export async function harness(options: HarnessOptions): Promise<Harness> {
  if (harnessActive)
    throw new Error("Overlapping harness lifetimes are not supported");
  harnessActive = true;
  try {
    return await createHarness(options, () => {
      harnessActive = false;
    });
  } catch (error) {
    harnessActive = false;
    throw error;
  }
}

async function createHarness(
  options: HarnessOptions,
  release: () => void,
): Promise<Harness> {
  if (options.entrypoint !== undefined && !isAbsolute(options.entrypoint))
    throw new Error("The extension entrypoint must be absolute");
  const root = mkdtempSync(join(tmpdir(), "lmsk-e2e-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFixtures(cwd, agentDir, options);
  const provider = await fakeProvider();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const restoreAgentDir = () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    release();
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: AgentSession | undefined;
  const runs = new Set<PrintRun>();
  try {
    const providerConfig: ProviderConfig = {
      baseUrl: provider.url,
      apiKey: "fake-key",
      api: "openai-completions",
      models: [
        {
          type: "chat",
          id: "m",
          name: "m",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
    };
    const register: ExtensionFactory = (pi) => {
      pi.registerProvider("fake", providerConfig);
    };
    const providerPath = join(agentDir, "provider.mjs");
    writeFileSync(
      providerPath,
      `export default pi => pi.registerProvider("fake", ${JSON.stringify(providerConfig)});`,
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: {
        enabled: options.retry ?? false,
        maxRetries: MAX_RETRIES,
        baseDelayMs: RETRY_DELAY_MS,
        maxAgentDelayMs: RETRY_DELAY_MS,
      },
    });
    settingsManager.setProjectTrusted(options.trusted ?? false);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [register, ...options.extensions],
      additionalExtensionPaths: options.entrypoint ? [options.entrypoint] : [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    if (resourceLoader.getExtensions().errors.length > 0)
      throw new Error("Extension loading failed; integration cannot run");
    const created = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: options.persist
        ? SessionManager.create(cwd, join(root, "sessions"))
        : SessionManager.inMemory(cwd),
      thinkingLevel: "off",
    });
    session = created.session;
    await session.bindExtensions({});
    const model = session.modelRuntime.getModel("fake", "m");
    if (!model) throw new Error("fake model is not registered");
    await session.setModel(model);
    let disposal: Promise<void> | undefined;
    return {
      session,
      provider,
      cwd,
      agentDir,
      sent: () => provider.bodies.join("\n"),
      print: (args) => {
        if (disposal) return Promise.reject(new Error("Harness is closing"));
        return printSession(
          cwd,
          agentDir,
          providerPath,
          options.entrypoint,
          args,
          runs,
        );
      },
      dispose: () => {
        disposal ??= closeHarness(
          created.session,
          provider,
          restoreAgentDir,
          runs,
        );
        return disposal;
      },
    };
  } catch (error) {
    await closeHarness(session, provider, restoreAgentDir, runs);
    throw error;
  }
}
