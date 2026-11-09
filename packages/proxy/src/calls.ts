import { CodedError, type Guard, isRecord } from "@hugolopes45/lmsk-core";
import { readJson, writeJson } from "./private-file.ts";

/** A tool call as the provider sent it: its input holds fakes only, so the file holds no real. */
export interface SavedCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface SavedCalls {
  get(id: string): SavedCall | undefined;
  save(id: string, call: SavedCall): void;
}

/** What a replay needs from the proxy profile. */
export interface ReplayProfile {
  /** The directory that the agent started in, for relative paths. The agent can run in another directory later, so the deny hook, which gets the current one, is the check that counts. */
  cwd: string;
  /** The input field that holds a shell command, for a shell tool. */
  commandKey(tool: string): string | undefined;
  /** The path that a call to `tool` opens. */
  pathOf(tool: string, input: Record<string, unknown>): string | undefined;
}

function savedCall(value: unknown): SavedCall {
  if (!isRecord(value) || typeof value.tool !== "string")
    throw new CodedError("CALLS_INVALID");
  if (!isRecord(value.input)) throw new CodedError("CALLS_INVALID");
  return { tool: value.tool, input: value.input };
}

function readCalls(path: string): Map<string, SavedCall> {
  const calls = readJson(path, "CALLS_INVALID");
  if (calls === undefined) return new Map();
  if (!isRecord(calls)) throw new CodedError("CALLS_INVALID");
  return new Map(
    Object.entries(calls).map(([id, call]) => [id, savedCall(call)]),
  );
}

/**
 * Calls in a private file, so that a resumed agent session can replay its history. Each save reads
 * the file again, so the calls of another run on the same session stay in it. Without a lock, two
 * saves in the same instant can still drop one call.
 */
export function fileCalls(path: string): SavedCalls {
  let calls = readCalls(path);
  return {
    get: (id) => calls.get(id),
    save(id, call) {
      calls = new Map([...calls, ...readCalls(path), [id, call]]);
      writeJson(path, Object.fromEntries(calls));
    },
  };
}

/**
 * A forked agent session resends the calls of its parent under a new session id. This session's
 * guard cannot restore the parent's fakes, so a short real in those calls would reach the provider.
 * The files are read again on each miss, because the parent can save a call at any time, in this
 * proxy or in another one. An id in no file stays unknown: each call is saved before the agent sees it.
 */
export function unforkedCalls(
  own: SavedCalls,
  otherPaths: () => readonly string[],
): SavedCalls {
  const unknown = new Set<string>();
  return {
    get(id) {
      const call = own.get(id);
      if (call !== undefined || unknown.has(id)) return call;
      if (otherPaths().some((path) => readCalls(path).has(id)))
        throw new CodedError("FORKED_SESSION");
      unknown.add(id);
      return undefined;
    },
    save: (id, call) => own.save(id, call),
  };
}

export function memoryCalls(): SavedCalls {
  const calls = new Map<string, SavedCall>();
  return {
    get: (id) => calls.get(id),
    save: (id, call) => calls.set(id, call),
  };
}

/** Restores a copy of the call's input. Replayed on every request, so the current configuration decides. */
export function replay(
  guard: Guard,
  profile: ReplayProfile,
  id: string,
  { tool, input: saved }: SavedCall,
): { blocked: boolean; reals: string[]; input: Record<string, unknown> } {
  const input = structuredClone(saved);
  const result = guard.restoredBy({
    id,
    tool,
    input,
    // The proxy gets the tool names from the model; the configuration's `restoredTools` limits restores to the agent's own tools.
    verified: true,
    commandKey: profile.commandKey(tool),
    cwd: profile.cwd,
    path: () => profile.pathOf(tool, input),
  });
  return { ...result, input };
}

export const WITHHELD =
  "lmsk: withheld. This tool call opened a protected path.";
export const HIDDEN =
  "lmsk: withheld. This tool result holds a secret spaced out, wrapped, reversed or encoded.";
