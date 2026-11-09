import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream/promises";
import { errorCode, type Guard, type GuardHost } from "../core/index.ts";
import { decodeJson, readBody } from "./body.ts";
import {
  HIDDEN,
  type ReplayProfile,
  replay,
  type SavedCalls,
  WITHHELD,
} from "./calls.ts";
import { Sessions, type SessionOptions } from "./sessions.ts";
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

/** Replacements for the tool calls and tool results of a request, by call id. */
export interface TurnEdit {
  input(id: string, value: unknown): unknown;
  result(id: string, value: unknown): unknown;
}

/** What a proxy adapter supplies. */
export interface ProxyProfile extends GuardHost, ReplayProfile {
  /** The provider base URL for a request. The request path after the launch token is appended to it. */
  upstream(headers: IncomingHttpHeaders): string;
  /** Headers that the proxy forwards unchanged besides the credentials, such as ids that the provider checks or that the agent makes per session. */
  keptHeaders: readonly string[];
  /** The agent session id that a request carries, if any. */
  sessionId(headers: IncomingHttpHeaders): string | undefined;
  /** A codec for one response stream; `restore` gives the input that the agent gets for a tool call. */
  codec(restore: (call: ToolInput) => Record<string, unknown>): StreamCodec;
  /** Copies a request payload with its tool call inputs and tool results replaced through `edit`. */
  turns(payload: unknown, edit: TurnEdit): unknown;
}

/** A session's guard and tool calls. */
interface Turn {
  guard: Guard;
  calls: SavedCalls;
  profile: ProxyProfile;
}

interface MaskedRequest {
  headers: [string, string][];
  body: string | undefined;
}

export interface RunningProxy {
  /** The base URL to give the agent. It holds the launch token. */
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
  { guard, profile }: Turn,
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

/**
 * The agent resends the reals that the proxy restored into its tool calls. Each call input goes
 * back to the provider's fake input, a blocked call's result and a result that hides a real are
 * withheld, and the reals of the other calls are masked everywhere, also when too short to learn.
 */
async function maskedBody(
  req: IncomingMessage,
  { guard, calls, profile }: Turn,
): Promise<string | undefined> {
  const body = await readBody(req);
  if (body.length === 0) return undefined;
  const payload = decodeJson(body, req.headers["content-encoding"]);
  const reals: string[] = [];
  const edited = profile.turns(payload, {
    input: (id, value) => calls.get(id)?.input ?? value,
    result(id, value) {
      const saved = calls.get(id);
      if (saved === undefined) return value;
      const replayed = replay(guard, profile, id, saved);
      if (replayed.blocked) return WITHHELD;
      reals.push(...replayed.reals);
      return value;
    },
  });
  // The whole payload teaches the vault first, so a result is checked against every real of the request.
  const masked = await guard.maskPayload(edited, reals);
  const results: unknown[] = [];
  profile.turns(masked, {
    input: (_id, value) => value,
    result: (_id, value) => results.push(value),
  });
  const hiding = await guard.hidingResults(results);
  return JSON.stringify(
    profile.turns(masked, {
      input: (_id, value) => value,
      result: (_id, value) => (hiding.has(value) ? HIDDEN : value),
    }),
  );
}

/** Saves each streamed call and gives the agent its restored input, or the provider's input when blocked. */
function restorer({ guard, calls, profile }: Turn) {
  return ({ id, tool, input }: ToolInput): Record<string, unknown> => {
    calls.save(id, { tool, input });
    const replayed = replay(guard, profile, id, { tool, input });
    return replayed.blocked ? input : replayed.input;
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
  turn: Turn,
): Promise<void> {
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
  });
  // fetch decodes the response, so the encoding and length headers no longer hold.
  res.writeHead(upstream.status, forwardedHeaders(upstream.headers));
  if (upstream.body === null) res.end();
  else if (
    upstream.headers.get("content-type")?.startsWith("text/event-stream")
  )
    await pipeline(
      restoredStream(upstream.body, turn.profile.codec(restorer(turn))),
      res,
    );
  else await pipeline(upstream.body, res);
}

/** Starts a loopback proxy that masks every request body with the session's guard before it reaches `profile.upstream`. */
export async function startProxy(
  profile: ProxyProfile,
  options: SessionOptions,
): Promise<RunningProxy> {
  const token = randomBytes(32).toString("base64url");
  const prefix = `/${token}/`;
  const sessions = new Sessions(profile, options);
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (!path.startsWith(prefix)) return refuse(res, 403, "FORBIDDEN");
    let masked: MaskedRequest;
    let turn: Turn;
    try {
      const id = profile.sessionId(req.headers);
      turn = { guard: sessions.guard(id), calls: sessions.calls(id), profile };
      const body = await maskedBody(req, turn);
      masked = { headers: await maskedHeaders(req.headers, turn), body };
    } catch (error) {
      return refuse(res, 400, errorCode(error));
    }
    const url = `${profile.upstream(req.headers).replace(/\/$/, "")}/${path.slice(prefix.length)}`;
    await forward(req, res, url, masked, turn).catch(() => {
      if (res.headersSent) res.destroy();
      else refuse(res, 502, "UPSTREAM", true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("proxy has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          sessions.close();
          resolve();
        });
      }),
  };
}
