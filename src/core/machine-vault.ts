import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./config.ts";
import { CodedError } from "./errors.ts";
import { keyedBytes } from "./keyed-bytes.ts";
import { type Journal, Vault, type VaultEntry, VaultError } from "./vault.ts";

export type MachineVaultCode =
  "STORE_CORRUPT" | "STORE_UNSAFE" | "STORE_BUSY" | "STORE_IO";

export class MachineVaultError extends CodedError<MachineVaultCode> {}

const KEY_BYTES = 32;
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

/** The vault file of the machine: append-only lines that every process reads in order. */
class FileJournal implements Journal {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly calls: Map<string, string[]>;
  /** The end of the last complete line read. */
  private offset = 0;
  /** How many bytes after `offset` the last read found. Under the lock, they are a line that a stopped write did not finish. */
  private torn = 0;
  /** No other process writes or cuts the file while this process holds the lock. */
  private holding = false;

  constructor(dir: string, calls: Map<string, string[]>) {
    this.path = join(dir, "vault.jsonl");
    this.lockPath = join(dir, "vault.lock");
    this.calls = calls;
  }

  locked<T>(write: () => T): T {
    const owner = io(() => acquire(this.lockPath));
    this.holding = true;
    try {
      return write();
    } finally {
      this.holding = false;
      io(() => {
        unlinkSync(owner);
        rmdirSync(this.lockPath);
      });
    }
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
      .map(parseLine);
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
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
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

/** Reads the key, or creates it. Call it under the lock, so no process reads a key before it is written. */
function machineKey(path: string): Buffer {
  try {
    const fd = openSync(path, "wx", FILE_MODE);
    try {
      const key = randomBytes(KEY_BYTES);
      writeAll(fd, key);
      fsyncSync(fd);
      return key;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  assertPrivate(path, false);
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES)
    throw new MachineVaultError("STORE_CORRUPT", "the key has a wrong length");
  return key;
}

/**
 * The vault that every lmsk process of the user shares: one key, so a real gets the same fakes
 * in every process, and one journal, so a fake restores in every process.
 */
export class MachineVault {
  readonly vault: Vault;
  private readonly journal: FileJournal;
  private readonly calls: Map<string, string[]>;

  private constructor(
    journal: FileJournal,
    calls: Map<string, string[]>,
    key: Buffer,
  ) {
    this.journal = journal;
    this.calls = calls;
    this.vault = new Vault(keyedBytes(key), [], journal);
  }

  /** Opens the vault in `dir`, which it creates when missing. */
  static open(dir: string): MachineVault {
    const calls = new Map<string, string[]>();
    const journal = new FileJournal(dir, calls);
    const key = io(() => {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      assertPrivate(dir, true);
      return journal.locked(() => {
        closeSync(openSync(join(dir, "vault.jsonl"), "a", FILE_MODE));
        assertPrivate(join(dir, "vault.jsonl"), false);
        return machineKey(join(dir, "key"));
      });
    });
    return new MachineVault(journal, calls, key);
  }

  /** Saves the reals that a tool call got back, so that every process masks them in that call's history. */
  recordCall(id: string, reals: readonly string[]): void {
    if (reals.length === 0) return;
    this.journal.locked(() => {
      this.vault.refresh();
      this.journal.appendCall(id, reals);
    });
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
