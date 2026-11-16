import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./config.ts";
import { CodedError } from "./errors.ts";
import { keyedBytes } from "./keyed-bytes.ts";
import { type Journal, Vault, type VaultEntry, VaultError } from "./vault.ts";

export type MachineVaultCode =
  | "CALL_ID_INVALID"
  | "STORE_CORRUPT"
  | "STORE_UNSAFE"
  | "STORE_BUSY"
  | "STORE_IO"
  | "VAULT_ENDED";

export class MachineVaultError extends CodedError<MachineVaultCode> {}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** A writer holds the lock only while it renders one batch, so a longer wait means a stuck writer. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 5;
/** Bounds the records of tool calls, which have no other limit, and so the time to read the vault. */
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Maps a filesystem failure to STORE_IO. Other errors pass through. */
function io<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof CodedError) throw error;
    if (isRecord(error) && typeof error.code === "string")
      throw new MachineVaultError("STORE_IO", `filesystem error ${error.code}`);
    throw error;
  }
}

/** Refuses a path that is not an owner-only directory or file of the effective user. */
function assertPrivate(path: string, directory: boolean): void {
  const stats = lstatSync(path);
  const kind = directory ? stats.isDirectory() : stats.isFile();
  const mode = directory ? DIR_MODE : FILE_MODE;
  const euid = process.geteuid?.();
  if (
    !kind ||
    (stats.mode & 0o777) !== mode ||
    (euid !== undefined && stats.uid !== euid)
  )
    throw new MachineVaultError(
      "STORE_UNSAFE",
      `${path} must be a ${directory ? "directory" : "file"} with mode ${mode.toString(8)} of the current user`,
    );
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function isStale(pid: string): boolean {
  if (!/^\d+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return isCode(error, "ESRCH");
  }
}

function reclaimDirectory(path: string): boolean {
  const owners = readdirSync(path);
  if (owners.length !== 1) return false;
  const owner = owners[0];
  const pid = /^(\d+)-[a-f0-9]{32}$/.exec(owner)?.[1];
  if (pid === undefined || !isStale(pid)) return false;
  // Only the process that removes this exact marker may remove its directory.
  unlinkSync(join(path, owner));
  rmdirSync(path);
  return true;
}

function reclaim(path: string): boolean {
  try {
    if (lstatSync(path).isDirectory()) return reclaimDirectory(path);
    if (!isStale(readFileSync(path, "utf8"))) return false;
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isCode(error, "EPERM") || !lstatSync(path).isDirectory())
        throw error;
    }
    return true;
  } catch (error) {
    if (
      isCode(error, "ENOENT") ||
      isCode(error, "ENOTDIR") ||
      isCode(error, "EISDIR")
    )
      return true;
    throw error;
  }
}

/** Claims a directory whose unique owner marker cannot name a later holder. */
function acquire(path: string): string {
  const owner = join(path, `${process.pid}-${randomBytes(16).toString("hex")}`);
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(path, DIR_MODE);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (Date.now() > until)
        throw new MachineVaultError("STORE_BUSY", "the vault lock is held");
      if (!reclaim(path)) Atomics.wait(SLEEP, 0, 0, LOCK_POLL_MS);
      continue;
    }
    let created = false;
    try {
      const fd = openSync(owner, "wx", FILE_MODE);
      created = true;
      closeSync(fd);
      return owner;
    } catch (error) {
      if (created) unlinkSync(owner);
      rmdirSync(path);
      throw error;
    }
  }
}

/** The fakes use the key too, so the journal gets its own key from it. */
function lineKey(key: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", key, Buffer.alloc(0), "lmsk vault line", KEY_BYTES),
  );
}

function seal(key: Buffer, text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function unseal(key: Buffer, line: string): string {
  const bytes = Buffer.from(line, "base64");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, IV_BYTES),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new MachineVaultError(
      "STORE_CORRUPT",
      "a vault line does not decrypt with the key",
    );
  }
}

type Line =
  | { kind: "mapping"; entry: VaultEntry }
  | { kind: "call"; id: string; reals: string[] };

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function parseLine(text: string): Line {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MachineVaultError("STORE_CORRUPT", "a vault line is not JSON");
  }
  if (isRecord(data) && isText(data.r) && isText(data.f))
    return { kind: "mapping", entry: [data.r, data.f] };
  if (
    isRecord(data) &&
    isText(data.c) &&
    Array.isArray(data.r) &&
    data.r.every(isText)
  )
    return { kind: "call", id: data.c, reals: data.r };
  throw new MachineVaultError(
    "STORE_CORRUPT",
    "a vault line has no known shape",
  );
}

/** Not `sessions`: lmsk 0.2.1 keeps its session files there. */
const sessionsDir = (stateDir: string) => join(stateDir, "session-vaults");

/** The vault folder of a session. The id is hashed because the agent sets it, for example in a request header. */
export function sessionDir(stateDir: string, sessionId: string): string {
  return join(
    sessionsDir(stateDir),
    createHash("sha256").update(sessionId).digest("hex"),
  );
}

/** Deletes the key first, so a journal that a failed delete leaves cannot be read. */
export function deleteVault(dir: string): void {
  io(() => {
    rmSync(join(dir, "key"), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
}

/** The shared vault of lmsk 0.3 holds reals in clear. The key goes first, as in `deleteVault`. */
export function deleteSharedVault(stateDir: string): void {
  io(() => {
    for (const name of ["key", "vault.jsonl"])
      rmSync(join(stateDir, name), { force: true });
  });
}

/** Deletes the vault in `dir` when no process used it since `since`. */
export function deleteIdleVault(dir: string, since: number): void {
  // One call: another process can delete the vault between an exists check and the stat.
  const stat = io(() => lstatSync(dir, { throwIfNoEntry: false }));
  if (stat !== undefined && stat.mtimeMs < since) deleteVault(dir);
}

/** Deletes each session vault that no process used since `since`, such as the vault of a crashed agent. */
export function deleteIdleVaults(stateDir: string, since: number): void {
  const parent = sessionsDir(stateDir);
  const names = io(() => {
    mkdirSync(parent, { recursive: true, mode: DIR_MODE });
    return readdirSync(parent);
  });
  // One vault that cannot be deleted must not keep the others, which hold keys and reals, on disk.
  const errors: unknown[] = [];
  for (const name of names)
    try {
      deleteIdleVault(join(parent, name), since);
    } catch (error) {
      errors.push(error);
    }
  if (errors.length > 0) throw errors[0];
}

const lockPathOf = (dir: string) => join(dir, "vault.lock");

function withLock<T>(lockPath: string, write: () => T): T {
  const owner = io(() => acquire(lockPath));
  try {
    return write();
  } finally {
    io(() => {
      unlinkSync(owner);
      rmdirSync(lockPath);
    });
  }
}

/** The vault file: append-only encrypted lines that every process reads in order. */
class FileJournal implements Journal {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly calls: Map<string, string[]>;
  private readonly key: Buffer;
  /** The end of the last complete line read. */
  private offset = 0;
  /** How many bytes after `offset` the last read found. Under the lock, they are a line that a stopped write did not finish. */
  private torn = 0;
  /** No other process writes or cuts the file while this process holds the lock. */
  private holding = false;

  constructor(dir: string, calls: Map<string, string[]>, key: Buffer) {
    this.path = join(dir, "vault.jsonl");
    this.lockPath = lockPathOf(dir);
    this.calls = calls;
    this.key = lineKey(key);
  }

  locked<T>(write: () => T): T {
    return withLock(this.lockPath, () => {
      this.holding = true;
      try {
        return write();
      } finally {
        this.holding = false;
      }
    });
  }

  /** Moves past the new lines only after all of them parse and `take` accepts them, so a refused line is read again. */
  unread(take: (entries: VaultEntry[]) => void): void {
    const bytes = io(() => this.readNew());
    // Counts raw bytes: a decoded torn character has another length.
    const end = bytes.lastIndexOf(0x0a) + 1;
    const lines = bytes
      .toString("utf8", 0, end)
      .split("\n")
      .filter((raw) => raw !== "")
      .map((raw) => parseLine(unseal(this.key, raw)));
    take(
      lines.flatMap((line) => (line.kind === "mapping" ? [line.entry] : [])),
    );
    for (const line of lines)
      if (line.kind === "call") this.addCall(line.id, line.reals);
    this.offset += end;
    this.torn = bytes.length - end;
  }

  append(entries: VaultEntry[]): void {
    this.write(entries.map(([real, fake]) => ({ r: real, f: fake })));
  }

  /** Saves a tool call's reals. Call it inside `locked`, after `unread`. */
  appendCall(id: string, reals: readonly string[]): void {
    this.write([{ c: id, r: reals }]);
    this.addCall(id, reals);
  }

  /** A call id can have many records, such as one per nested call that a host records under its caller. */
  private addCall(id: string, reals: readonly string[]): void {
    this.calls.set(id, [...(this.calls.get(id) ?? []), ...reals]);
  }

  /** Appends one line per record, after it cuts the `torn` bytes. It refuses a file whose size changed since the read under the lock. */
  private write(records: readonly object[]): void {
    if (records.length === 0) return;
    const bytes = Buffer.from(
      records
        .map((record) => `${seal(this.key, JSON.stringify(record))}\n`)
        .join(""),
    );
    if (this.offset + bytes.length > MAX_JOURNAL_BYTES)
      throw new VaultError(
        "VAULT_FULL",
        `the vault file would exceed ${MAX_JOURNAL_BYTES} bytes`,
      );
    io(() => {
      const fd = openSync(this.path, "a");
      try {
        if (fstatSync(fd).size !== this.offset + this.torn)
          throw new MachineVaultError("STORE_CORRUPT", "the vault changed");
        if (this.torn > 0) ftruncateSync(fd, this.offset);
        writeAll(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
    this.offset += bytes.length;
  }

  /**
   * Under the lock, reads to the end, so `write` cuts only a torn line. Without the lock, one read: a writer
   * can cut a torn line meanwhile, and a second read could join its start to the next line. A short read
   * leaves the rest for the next call.
   */
  private readNew(): Buffer {
    const fd = openSync(this.path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset)
        throw new MachineVaultError("STORE_CORRUPT", "the vault got shorter");
      const bytes = Buffer.alloc(size - this.offset);
      let read = readSync(fd, bytes, 0, bytes.length, this.offset);
      while (this.holding && read < bytes.length) {
        const count = readSync(
          fd,
          bytes,
          read,
          bytes.length - read,
          this.offset + read,
        );
        if (count === 0) break;
        read += count;
      }
      return bytes.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }
}

/** Calls fsync on a directory, so the names it holds are flushed. Power-loss durability depends on the platform's fsync. */
function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the key, or creates it. A new key is written under a temporary name and linked into place,
 * so a crash leaves no short key. Call it under the lock, so no process reads a key before it is written.
 */
function machineKey(path: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  const candidate = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const fd = openSync(candidate, "wx", FILE_MODE);
  try {
    writeAll(fd, key);
    fsyncSync(fd);
    linkSync(candidate, path);
    fsyncDirectory(dirname(path));
    return key;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  } finally {
    closeSync(fd);
    unlinkSync(candidate);
  }
  assertPrivate(path, false);
  const existing = readFileSync(path);
  if (existing.length !== KEY_BYTES)
    throw new MachineVaultError("STORE_CORRUPT", "the key has a wrong length");
  return existing;
}

/**
 * The vault in one folder, which every process of a session shares: one key, so a real gets the
 * same fakes in every process, and one journal, so a fake restores in every process.
 */
export class MachineVault {
  readonly vault: Vault;
  private readonly dir: string;
  private readonly journal: FileJournal;
  private readonly calls: Map<string, string[]>;

  private constructor(
    dir: string,
    journal: FileJournal,
    calls: Map<string, string[]>,
    key: Buffer,
  ) {
    this.dir = dir;
    this.journal = journal;
    this.calls = calls;
    this.vault = new Vault(keyedBytes(key), [], journal);
  }

  /** Opens the vault in `dir`, which it creates when missing. */
  static open(dir: string): MachineVault {
    const calls = new Map<string, string[]>();
    const key = io(() => {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      assertPrivate(dir, true);
      return withLock(lockPathOf(dir), () => {
        closeSync(openSync(join(dir, "vault.jsonl"), "a", FILE_MODE));
        assertPrivate(join(dir, "vault.jsonl"), false);
        return machineKey(join(dir, "key"));
      });
    });
    return new MachineVault(dir, new FileJournal(dir, calls, key), calls, key);
  }

  /** Whether a process deleted the vault, such as at the end of the session. */
  get ended(): boolean {
    return !existsSync(join(this.dir, "key"));
  }

  /** Marks the vault used now, for `deleteIdleVault` in every process. */
  markUsed(): void {
    const now = new Date();
    io(() => utimesSync(this.dir, now, now));
  }

  /** Saves the reals that a tool call got back, so that every process masks them in that call's history. A call without reals is saved too, for `assertRecorded`. */
  recordCall(id: string, reals: readonly string[]): void {
    // An empty id would make every later read of the journal fail.
    if (!isText(id))
      throw new MachineVaultError("CALL_ID_INVALID", "the call id is empty");
    this.journal.locked(() => {
      this.vault.refresh();
      this.journal.appendCall(id, reals);
    });
  }

  /** Throws VAULT_ENDED for a call that this vault did not save: an ended vault restored it, and its short reals are lost. */
  assertRecorded(ids: Iterable<string>): void {
    this.vault.refresh();
    for (const id of ids)
      if (!this.calls.has(id))
        throw new MachineVaultError(
          "VAULT_ENDED",
          "the conversation holds a tool call of an ended vault",
        );
  }

  /** The reals that the calls with these ids got back. */
  realsOf(ids: Iterable<string>): string[] {
    this.vault.refresh();
    const reals = new Set<string>();
    for (const id of ids)
      for (const real of this.calls.get(id) ?? []) reals.add(real);
    return [...reals];
  }
}
