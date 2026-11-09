import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CodedError,
  Guard,
  type GuardHost,
  type HostContext,
  localIdentityRules,
  type ReferenceRecords,
} from "@hugolopes45/lmsk-core";
import {
  fileCalls,
  memoryCalls,
  type SavedCalls,
  unforkedCalls,
} from "./calls.ts";
import { readJson, writeJson } from "./private-file.ts";

export interface SessionOptions {
  /** Global configuration files, in merge order. The proxy reads no project file. */
  configPaths: readonly string[];
  /** The private directory of the vault stores and session records. */
  stateDir: string;
  /** The environment of the agent's processes. */
  env: Readonly<Record<string, string | undefined>>;
  notify: HostContext["ui"]["notify"];
}

/** Records in a private file, so that a resumed agent session finds its vault store. */
function fileReferences(path: string): ReferenceRecords {
  const read = (): unknown[] => {
    const records = readJson(path, "STORE_REFERENCE_INVALID");
    if (records === undefined) return [];
    if (!Array.isArray(records))
      throw new CodedError("STORE_REFERENCE_INVALID");
    return records;
  };
  return {
    read,
    append: (reference) => writeJson(path, [...read(), reference]),
  };
}

function memoryReferences(): ReferenceRecords {
  const records: unknown[] = [];
  return {
    read: () => records,
    append: (reference) => records.push(reference),
  };
}

/** One guard per agent session id. A request without an id shares one guard that lives as long as the proxy. */
export class Sessions {
  private readonly guards = new Map<string | undefined, Guard>();
  private readonly saved = new Map<string | undefined, SavedCalls>();
  private readonly host: GuardHost;
  private readonly options: SessionOptions;
  readonly ctx: HostContext;

  constructor(host: GuardHost, options: SessionOptions) {
    this.host = host;
    this.options = options;
    // The proxy answers a failed request itself, so there is no operation to abort.
    this.ctx = { ui: { notify: options.notify }, abort: () => undefined };
  }

  guard(sessionId: string | undefined): Guard {
    const known = this.guards.get(sessionId);
    if (known !== undefined) return known;
    const guard = new Guard(this.host);
    this.guards.set(sessionId, guard);
    guard.open(() => this.openOptions(sessionId), this.ctx);
    return guard;
  }

  /** The tool calls of a session, read once. */
  calls(sessionId: string | undefined): SavedCalls {
    const known = this.saved.get(sessionId);
    if (known !== undefined) return known;
    const calls =
      sessionId === undefined
        ? memoryCalls()
        : this.sessionFileCalls(sessionId);
    this.saved.set(sessionId, calls);
    return calls;
  }

  private sessionFileCalls(sessionId: string): SavedCalls {
    const own = this.sessionFile(sessionId, "calls.json");
    const dir = dirname(own);
    const others = () =>
      readdirSync(dir)
        .filter(
          (name) => name.endsWith(".calls.json") && name !== basename(own),
        )
        .map((name) => join(dir, name));
    return unforkedCalls(fileCalls(own), others);
  }

  /** A private file of the session, named by a hash so that the session id stays out of the file system. */
  private sessionFile(sessionId: string, suffix: string): string {
    const sessionsDir = join(this.options.stateDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(sessionId).digest("hex");
    return join(sessionsDir, `${hash}.${suffix}`);
  }

  private openOptions(sessionId: string | undefined) {
    const { stateDir, configPaths, env } = this.options;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    return {
      configPaths,
      projectConfigPath: undefined,
      storeDir: join(stateDir, "vaults"),
      references:
        sessionId === undefined
          ? memoryReferences()
          : fileReferences(this.sessionFile(sessionId, "json")),
      env,
      defaultRules: localIdentityRules(),
    };
  }

  close(): void {
    for (const guard of this.guards.values()) guard.close();
    this.guards.clear();
    this.saved.clear();
  }
}
