import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CodedError,
  errorCode,
  Guard,
  type GuardHost,
  type HostContext,
  isRecord,
  localIdentityRules,
  type TextRestorer,
} from "../core/index.ts";
import { decodeJson, readBody } from "./body.ts";
import { readEvents, type SseEvent, writeEvent } from "./sse.ts";

/** A tool call that a response stream carries, with its parsed input. */
export interface ToolInput {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** Rewrites a response stream, one event at a time. */
export interface StreamCodec {
  /** Returns the events to send now. */
  push(event: SseEvent): SseEvent[];
}

/** What a proxy adapter supplies. */
export interface ProxyProfile extends GuardHost {
  /** The provider base URL. The request path after the token is appended to it. */
  upstream: string;
  /** Headers that the proxy forwards unchanged besides the credentials, such as ids that the provider checks or that the agent makes per session. */
  keptHeaders: readonly string[];
  /** A codec for one response stream: `restore` gives the input that the agent gets for a tool call, `text` restores one text block. */
  codec(
    restore: (call: ToolInput) => Record<string, unknown>,
    text: () => TextRestorer,
  ): StreamCodec;
  /** The directory of the proxy process, for relative paths. The agents that the proxy serves run in other directories, so the deny hook, which gets the directory of each call, is the check that counts. */
  cwd: string;
  /** The input field that holds a shell command, for a shell tool. */
  commandKey(tool: string): string | undefined;
  /** The path that a call to `tool` opens. */
  pathOf(tool: string, input: Record<string, unknown>): string | undefined;
  /** The folders that a call to `tool` searches. */
  rootsOf(tool: string, input: Record<string, unknown>): string[];
}

export interface ProxyOptions {
  configPaths: readonly string[];
  /** The machine vault directory. */
  stateDir: string;
  env: Readonly<Record<string, string | undefined>>;
  notify: HostContext["ui"]["notify"];
  /** 0 picks a free port. */
  port: number;
  /** The first path segment of every request, so that no other local program uses the proxy. */
  token: string;
}

interface MaskedRequest {
  headers: [string, string][];
  body: string | undefined;
}

export interface RunningProxy {
  /** The base URL to give the agent. It holds the token. */
  url: string;
  close(): Promise<void>;
}

/** Headers that belong to one connection or to the body bytes, which the proxy re-creates. */
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

function forwardedHeaders(
  headers: IncomingHttpHeaders | Headers,
): [string, string][] {
  const entries =
    headers instanceof Headers ? [...headers] : Object.entries(headers);
  return entries.flatMap(([name, value]) =>
    value === undefined || DROPPED_HEADERS.has(name)
      ? []
      : [[name, Array.isArray(value) ? value.join(", ") : value]],
  );
}

/** The provider issued these values; it needs them unchanged. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
]);

/** Agents put the workspace, such as a git remote URL, in headers too. Call it after the body: the body teaches the vault, so a real gets the same fake in both. */
async function maskedHeaders(
  headers: IncomingHttpHeaders,
  guard: Guard,
  profile: ProxyProfile,
): Promise<[string, string][]> {
  const entries = forwardedHeaders(headers);
  const kept = ([name]: [string, string]) =>
    CREDENTIAL_HEADERS.has(name) || profile.keptHeaders.includes(name);
  const credentials = entries.filter(kept);
  const others = entries.filter((entry) => !kept(entry));
  const masked = await guard.maskTexts(others.map(([, value]) => value));
  return [
    ...credentials,
    ...others.map(([name], i): [string, string] => [name, masked[i]]),
  ];
}

/** Fails closed: the agent sees why, and does not retry a request that would fail the same way. */
/** The Anthropic and OpenAI SDKs obey `x-should-retry`: a masking failure fails again, a network failure may pass. */
function refuse(
  res: ServerResponse,
  status: number,
  code: string,
  retry = false,
): void {
  res.writeHead(status, {
    "content-type": "text/plain",
    "x-should-retry": String(retry),
  });
  res.end(`lmsk: ${code}`);
}

/** Masks a request. A call id in the body makes the reals that its call got back masked everywhere. */
async function maskedRequest(
  req: IncomingMessage,
  guard: Guard,
  profile: ProxyProfile,
): Promise<MaskedRequest> {
  const raw = await readBody(req);
  const body =
    raw.length === 0
      ? undefined
      : JSON.stringify(
          await guard.maskPayload(
            decodeJson(raw, req.headers["content-encoding"]),
          ),
        );
  return { headers: await maskedHeaders(req.headers, guard, profile), body };
}

/** Gives the agent a streamed call's restored input, or the provider's input when the call is blocked. */
function restorer(guard: Guard, profile: ProxyProfile) {
  return ({ id, tool, input }: ToolInput): Record<string, unknown> => {
    const call = {
      id,
      tool,
      input,
      // The proxy gets the tool names from the model; the configuration's `restoredTools` limits restores to the agent's own tools.
      verified: true,
      commandKey: profile.commandKey(tool),
      cwd: profile.cwd,
      targets: (restored: Record<string, unknown>) => {
        const path = profile.pathOf(tool, restored);
        return path === undefined ? [] : [path];
      },
      // The proxy serves every session, so it does not know the session folder of a relative root. The deny hook checks that root.
      roots: (restored: Record<string, unknown>) =>
        profile.rootsOf(tool, restored).filter((root) => isAbsolute(root)),
    };
    guard.restoreCall(call);
    return call.input;
  };
}

async function* restoredStream(
  body: AsyncIterable<Uint8Array>,
  codec: StreamCodec,
): AsyncGenerator<string> {
  for await (const event of readEvents(body))
    for (const out of codec.push(event)) yield writeEvent(out);
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  { headers, body }: MaskedRequest,
  codec: StreamCodec,
): Promise<void> {
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
    // fetch keeps x-api-key on a redirect to another origin.
    redirect: "error",
  });
  // fetch decodes the response, so the encoding and length headers no longer hold.
  res.writeHead(upstream.status, forwardedHeaders(upstream.headers));
  if (upstream.body === null) res.end();
  else if (
    upstream.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/event-stream")
  )
    await pipeline(restoredStream(upstream.body, codec), res);
  else await pipeline(upstream.body, res);
}

/** Starts a loopback proxy that masks every request with one guard over the machine vault before it reaches `profile.upstream`. */
export async function startProxy(
  profile: ProxyProfile,
  options: ProxyOptions,
): Promise<RunningProxy> {
  const prefix = `/${options.token}/`;
  const guard = new Guard(profile);
  const openGuard = (notify: ProxyOptions["notify"]) =>
    guard.open(
      () => ({
        configPaths: options.configPaths,
        projectConfigPath: undefined,
        stateDir: options.stateDir,
        env: options.env,
        defaultRules: localIdentityRules(),
      }),
      { ui: { notify }, abort: () => undefined },
    );
  openGuard(options.notify);
  const restore = restorer(guard, profile);
  const text = () => guard.textRestorer();
  // Requests without the token can come from any local process, so only the first one gets a notice.
  let forbiddenNoticed = false;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    if (!path.startsWith(prefix)) {
      if (!forbiddenNoticed) {
        forbiddenNoticed = true;
        options.notify("lmsk: FORBIDDEN", "error");
      }
      return refuse(res, 403, "FORBIDDEN");
    }
    // A failed open is retried, so a fixed config masks the next request. The retry sends no notice: the refusal carries the code.
    if (guard.blocked) openGuard(() => undefined);
    let masked: MaskedRequest;
    try {
      masked = await maskedRequest(req, guard, profile);
    } catch (error) {
      const code = errorCode(error);
      options.notify(`lmsk: ${code}`, "error");
      return refuse(res, 400, code);
    }
    const url = `${profile.upstream.replace(/\/$/, "")}/${path.slice(prefix.length)}`;
    await forward(req, res, url, masked, profile.codec(restore, text)).catch(
      (error: unknown) => {
        options.notify(`lmsk: a reply stopped: ${errorCode(error)}`, "error");
        if (res.headersSent) res.destroy();
        else refuse(res, 502, "UPSTREAM", true);
      },
    );
  };
  const server = createServer((req, res) => void handle(req, res));
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) =>
        reject(
          isRecord(error) && error.code === "EADDRINUSE"
            ? new CodedError("PORT_TAKEN")
            : error,
        );
      server.once("error", onError);
      server.listen(options.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    guard.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("proxy has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/${options.token}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          guard.close();
          resolve();
        });
      }),
  };
}
