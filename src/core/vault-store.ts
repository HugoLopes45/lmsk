import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./config.ts";
import { CodedError } from "./errors.ts";
import type { VaultEntry } from "./vault.ts";

export type VaultStoreCode =
  | "STORE_INVALID_ID"
  | "STORE_MISSING"
  | "STORE_EXISTS"
  | "STORE_CORRUPT"
  | "STORE_UNSAFE"
  | "STORE_CONFLICT"
  | "STORE_EXHAUSTED"
  | "STORE_BUSY"
  | "STORE_INVALID"
  | "STORE_IO";

export class VaultStoreError extends CodedError<VaultStoreCode> {}

/** A stored mapping and the revision it was read at. */
export type StoredVault = {
  readonly namespaceId: string;
  readonly revision: number;
  entries: VaultEntry[];
};

/** Mirrors the entry cap in vault.ts. */
const MAX_ENTRIES = 50000;
const NAMESPACE_BYTES = 16;
const NAMESPACE_ID = /^[0-9a-f]{32}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function storePath(baseDir: string, namespaceId: string): string {
  if (!NAMESPACE_ID.test(namespaceId))
    throw new VaultStoreError(
      "STORE_INVALID_ID",
      "namespace ID must be 32 lowercase hex characters",
    );
  return join(baseDir, `${namespaceId}.json`);
}

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Maps a filesystem failure to STORE_IO. Other errors are programming faults and pass through. */
function guarded<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof VaultStoreError) throw error;
    if (isRecord(error) && typeof error.code === "string")
      throw new VaultStoreError("STORE_IO", `filesystem error ${error.code}`);
    throw error;
  }
}

/** Copies a `[real, fake]` pair when both parts are non-empty strings. */
function pairOf(value: unknown): VaultEntry | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [real, fake] = value;
  return typeof real === "string" &&
    typeof fake === "string" &&
    real !== "" &&
    fake !== ""
    ? [real, fake]
    : undefined;
}

/** Copies a bounded list of pairs whose reals are distinct and whose fakes are distinct. */
function validEntries(value: unknown): VaultEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return undefined;
  const entries: VaultEntry[] = [];
  for (const item of value) {
    const entry = pairOf(item);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  const reals = new Set(entries.map(([real]) => real));
  const fakes = new Set(entries.map(([, fake]) => fake));
  return reals.size === entries.length && fakes.size === entries.length
    ? entries
    : undefined;
}

function parseStore(text: string): Pick<StoredVault, "revision" | "entries"> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VaultStoreError("STORE_CORRUPT", "store is not valid JSON");
  }
  const revision = isRecord(data) ? data.revision : undefined;
  const entries = isRecord(data) ? validEntries(data.entries) : undefined;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    entries === undefined
  )
    throw new VaultStoreError("STORE_CORRUPT", "store has an invalid shape");
  return { revision, entries };
}

function serialize(store: Pick<StoredVault, "revision" | "entries">): string {
  return JSON.stringify({ revision: store.revision, entries: store.entries });
}

/** Ownership is checked only where the platform reports an effective UID. */
function ownedByEffectiveUser(stats: { readonly uid: number }): boolean {
  const euid = process.geteuid?.();
  return euid === undefined || stats.uid === euid;
}

/** Refuses a path that is not a real, owner-only directory or file owned by the effective user. */
function assertPrivate(path: string, isDirectory: boolean): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isCode(error, "ENOENT"))
      throw new VaultStoreError("STORE_MISSING", "store not found");
    throw error;
  }
  const kindMatches = isDirectory ? stats.isDirectory() : stats.isFile();
  const mode = isDirectory ? DIR_MODE : FILE_MODE;
  if (
    !kindMatches ||
    (stats.mode & 0o777) !== mode ||
    !ownedByEffectiveUser(stats)
  )
    throw new VaultStoreError(
      "STORE_UNSAFE",
      `store path must be a ${isDirectory ? "directory" : "file"} with mode ${mode.toString(8)} owned by the current user`,
    );
}

/** Writes and flushes a new file beside `path`. Removes that file again if a step fails. */
function writeTemp(path: string, content: string): string {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", FILE_MODE);
  try {
    try {
      const bytes = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
  return temp;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates the base directory when missing, then validates it and flushes its
 * parent so the entry survives a crash. Runs on every call: a directory created
 * by an earlier call whose parent flush failed is not yet durable. Never creates
 * ancestors: the parent must exist.
 */
function ensureBaseDir(baseDir: string): void {
  try {
    mkdirSync(baseDir, { mode: DIR_MODE });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  assertPrivate(baseDir, true);
  syncDir(dirname(baseDir));
}

function readStore(baseDir: string, namespaceId: string): StoredVault {
  const path = storePath(baseDir, namespaceId);
  assertPrivate(baseDir, true);
  assertPrivate(path, false);
  return { namespaceId, ...parseStore(readFileSync(path, "utf8")) };
}

/**
 * Creates an empty store under a new random namespace ID. Never replaces an
 * existing store. The parent of `baseDir` must already exist.
 */
export function createVaultStore(baseDir: string): StoredVault {
  return guarded(() => {
    ensureBaseDir(baseDir);
    const namespaceId = randomBytes(NAMESPACE_BYTES).toString("hex");
    const path = storePath(baseDir, namespaceId);
    const store: StoredVault = { namespaceId, revision: 0, entries: [] };
    const temp = writeTemp(path, serialize(store));
    try {
      linkSync(temp, path);
    } catch (error) {
      if (isCode(error, "EEXIST"))
        throw new VaultStoreError("STORE_EXISTS", "store already exists");
      throw error;
    } finally {
      unlinkSync(temp);
    }
    syncDir(baseDir);
    return store;
  });
}

/** Loads an existing store. Throws when it is missing, unsafe or corrupt; never returns an empty store. */
export function loadVaultStore(
  baseDir: string,
  namespaceId: string,
): StoredVault {
  return guarded(() => readStore(baseDir, namespaceId));
}

/**
 * Replaces the entries when the store is still at `expected.revision`, under a
 * lock file. Returns the stored state at the next revision. A lock left by a
 * crashed writer blocks saves until removed by hand. A failed directory flush
 * after the rename means the save may have committed: reload to see the state,
 * but a reload does not prove durability. Do not retry blindly.
 */
export function saveVaultStore(
  baseDir: string,
  expected: Pick<StoredVault, "namespaceId" | "revision">,
  entries: VaultEntry[],
): StoredVault {
  const path = storePath(baseDir, expected.namespaceId);
  const validated = validEntries(entries);
  if (validated === undefined)
    throw new VaultStoreError(
      "STORE_INVALID",
      "entries are not a valid mapping",
    );
  return guarded(() => {
    assertPrivate(baseDir, true);
    const lock = join(baseDir, `${expected.namespaceId}.lock`);
    const lockFd = acquireLock(lock);
    let next: StoredVault;
    try {
      const current = readStore(baseDir, expected.namespaceId);
      if (current.revision !== expected.revision)
        throw new VaultStoreError(
          "STORE_CONFLICT",
          "store changed since it was loaded",
        );
      if (current.revision >= Number.MAX_SAFE_INTEGER)
        throw new VaultStoreError(
          "STORE_EXHAUSTED",
          "store revision cannot advance past the largest safe integer",
        );
      next = {
        namespaceId: expected.namespaceId,
        revision: current.revision + 1,
        entries: validated,
      };
      const temp = writeTemp(path, serialize(next));
      try {
        renameSync(temp, path);
      } catch (error) {
        unlinkSync(temp);
        throw error;
      }
      syncDir(baseDir);
    } finally {
      closeSync(lockFd);
      unlinkSync(lock);
    }
    syncDir(baseDir);
    return next;
  });
}

/** Creates the lock file; it is ours only when this call creates it. */
function acquireLock(lock: string): number {
  try {
    return openSync(lock, "wx", FILE_MODE);
  } catch (error) {
    if (isCode(error, "EEXIST"))
      throw new VaultStoreError(
        "STORE_BUSY",
        "store is locked by another writer",
      );
    throw error;
  }
}
