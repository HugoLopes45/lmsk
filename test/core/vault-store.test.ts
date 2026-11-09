import { execFile } from "node:child_process";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultStore,
  loadVaultStore,
  saveVaultStore,
  VaultStoreError,
  type StoredVault,
} from "../../src/core/vault-store.ts";
import type { VaultEntry } from "../../src/core/vault.ts";

/** Fault hooks at the fs and crypto boundary; unset hooks call the real functions. */
const faults = vi.hoisted(() => ({
  fsyncSync: undefined as undefined | ((fd: number) => void),
  linkSync: undefined as
    undefined | ((existing: string, created: string) => void),
  randomBytes: undefined as undefined | ((size: number) => Buffer),
  renameSync: undefined as undefined | ((from: string, to: string) => void),
  writeSync: undefined as
    | undefined
    | ((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset?: number | null,
        length?: number | null,
      ) => number),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) =>
      faults.fsyncSync ? faults.fsyncSync(fd) : actual.fsyncSync(fd),
    linkSync: (existing: string, created: string) =>
      faults.linkSync
        ? faults.linkSync(existing, created)
        : actual.linkSync(existing, created),
    renameSync: (from: string, to: string) =>
      faults.renameSync
        ? faults.renameSync(from, to)
        : actual.renameSync(from, to),
    writeSync: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number | null,
      length?: number | null,
    ) =>
      faults.writeSync
        ? faults.writeSync(fd, buffer, offset, length)
        : actual.writeSync(fd, buffer, offset, length),
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      faults.randomBytes ? faults.randomBytes(size) : actual.randomBytes(size),
  };
});

const REAL = "sk-live-REAL-VALUE-123";
const entries: VaultEntry[] = [[REAL, "sk-live-FAKE-VALUE-456"]];

const STORE_MODULE = fileURLToPath(
  new URL("../../src/core/vault-store.ts", import.meta.url),
);

/** Child process body: repeatedly loads then saves one entry, and prints the number of committed saves. */
const WRITER_SCRIPT = `
import { loadVaultStore, saveVaultStore, VaultStoreError } from ${JSON.stringify(STORE_MODULE)};
const [baseDir, namespaceId, tag, attempts] = process.argv.slice(2);
let committed = 0;
for (let attempt = 0; attempt < Number(attempts); attempt++) {
  const current = loadVaultStore(baseDir, namespaceId);
  const next = ["real-" + tag + "-" + attempt, "fake-" + tag + "-" + attempt];
  try {
    saveVaultStore(baseDir, current, [...current.entries, next]);
    committed++;
  } catch (error) {
    if (!(error instanceof VaultStoreError) || !["STORE_BUSY", "STORE_CONFLICT"].includes(error.code)) throw error;
  }
}
console.log(committed);
`;

const execFileAsync = promisify(execFile);

let base: string;

beforeEach(() => {
  base = join(mkdtempSync(join(tmpdir(), "vault-store-")), "vaults");
});

afterEach(() => {
  for (const key of Object.keys(faults) as (keyof typeof faults)[])
    faults[key] = undefined;
  rmSync(join(base, ".."), { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function storeFile(store: StoredVault): string {
  return join(base, `${store.namespaceId}.json`);
}

/** Runs `action` and returns the store error it throws. */
function failure(action: () => unknown): VaultStoreError {
  try {
    action();
  } catch (error) {
    if (error instanceof VaultStoreError) return error;
    throw error;
  }
  throw new Error("expected the action to throw");
}

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

describe("vault store", () => {
  it("creates an owner-only store that loads back as created", () => {
    const created = createVaultStore(base);
    expect(created.namespaceId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.revision).toBe(0);
    expect(created.entries).toEqual([]);
    expect(mode(base)).toBe(0o700);
    expect(mode(storeFile(created))).toBe(0o600);
    expect(loadVaultStore(base, created.namespaceId)).toEqual(created);
  });

  it("fails as missing when loading a namespace that was never created", () => {
    createVaultStore(base);
    const missing = "0".repeat(32);
    expect(failure(() => loadVaultStore(base, missing)).code).toBe(
      "STORE_MISSING",
    );
    expect(readdirSync(base)).toHaveLength(1);
  });

  it("fails as missing when the base directory does not exist", () => {
    expect(failure(() => loadVaultStore(base, "0".repeat(32))).code).toBe(
      "STORE_MISSING",
    );
    expect(() => statSync(base)).toThrow();
  });

  it("flushes the parent directory after creating the base directory", async () => {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const flushedInodes: number[] = [];
    faults.fsyncSync = (fd) => {
      const stats = real.fstatSync(fd);
      if (stats.isDirectory()) flushedInodes.push(stats.ino);
      real.fsyncSync(fd);
    };
    createVaultStore(base);
    expect(flushedInodes).toEqual([
      statSync(join(base, "..")).ino,
      statSync(base).ino,
    ]);
  });

  it("flushes the parent directory on retry after a failed flush left the base directory behind", async () => {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const parentInode = statSync(join(base, "..")).ino;
    const flushedInodes: number[] = [];
    let failParentFlush = true;
    faults.fsyncSync = (fd) => {
      const stats = real.fstatSync(fd);
      if (stats.isDirectory()) {
        flushedInodes.push(stats.ino);
        if (stats.ino === parentInode && failParentFlush) {
          failParentFlush = false;
          throw ioError("EIO");
        }
      }
      real.fsyncSync(fd);
    };
    expect(failure(() => createVaultStore(base)).code).toBe("STORE_IO");
    flushedInodes.length = 0;
    const created = createVaultStore(base);
    expect(flushedInodes).toEqual([parentInode, statSync(base).ino]);
    expect(loadVaultStore(base, created.namespaceId)).toEqual(created);
  });

  it("refuses to create a base directory whose parent is missing", () => {
    expect(
      failure(() => createVaultStore(join(base, "absent", "vaults"))).code,
    ).toBe("STORE_IO");
    expect(() => statSync(join(base, "absent"))).toThrow();
  });

  it("never replaces an existing store when creation picks the same namespace", () => {
    faults.randomBytes = (size) => Buffer.alloc(size, 0x11);
    const first = createVaultStore(base);
    const saved = saveVaultStore(base, first, entries);
    expect(failure(() => createVaultStore(base)).code).toBe("STORE_EXISTS");
    expect(loadVaultStore(base, saved.namespaceId).entries).toEqual(entries);
  });

  it("rejects namespace IDs that could escape the base directory, touching no file", () => {
    const store = createVaultStore(base);
    const before = readdirSync(base);
    for (const namespaceId of [
      "../escape",
      "/etc/passwd",
      `${store.namespaceId}/../../escape`,
      store.namespaceId.toUpperCase(),
      `${store.namespaceId}0`,
      "",
    ]) {
      expect(failure(() => loadVaultStore(base, namespaceId)).code).toBe(
        "STORE_INVALID_ID",
      );
      expect(
        failure(() =>
          saveVaultStore(base, { namespaceId, revision: 0 }, entries),
        ).code,
      ).toBe("STORE_INVALID_ID");
    }
    expect(readdirSync(base)).toEqual(before);
    expect(readdirSync(join(base, ".."))).toEqual(["vaults"]);
  });

  it("saves a new revision that loads back with the entries", () => {
    const created = createVaultStore(base);
    const saved = saveVaultStore(base, created, entries);
    expect(saved.revision).toBe(1);
    expect(loadVaultStore(base, created.namespaceId)).toEqual(saved);
    expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
  });

  it("refuses a save from a stale revision and keeps the newer store", () => {
    const created = createVaultStore(base);
    const writerA = loadVaultStore(base, created.namespaceId);
    const writerB = loadVaultStore(base, created.namespaceId);
    saveVaultStore(base, writerA, entries);
    const other: VaultEntry[] = [["Other-1234", "Fake-5678"]];
    expect(failure(() => saveVaultStore(base, writerB, other)).code).toBe(
      "STORE_CONFLICT",
    );
    expect(loadVaultStore(base, created.namespaceId).entries).toEqual(entries);
  });

  it("refuses to advance past the last safe revision and keeps the store readable", () => {
    const created = createVaultStore(base);
    const last = { ...created, revision: Number.MAX_SAFE_INTEGER };
    writeFileSync(
      storeFile(created),
      JSON.stringify({ revision: last.revision, entries: [] }),
      { mode: 0o600 },
    );
    expect(failure(() => saveVaultStore(base, last, entries)).code).toBe(
      "STORE_EXHAUSTED",
    );
    expect(loadVaultStore(base, created.namespaceId)).toEqual(last);
  });

  it("refuses a save while another writer holds the lock, and keeps that lock", () => {
    const created = createVaultStore(base);
    const lock = join(base, `${created.namespaceId}.lock`);
    writeFileSync(lock, "", { mode: 0o600 });
    expect(failure(() => saveVaultStore(base, created, entries)).code).toBe(
      "STORE_BUSY",
    );
    expect(readdirSync(base).sort()).toEqual(
      [`${created.namespaceId}.json`, `${created.namespaceId}.lock`].sort(),
    );
    expect(loadVaultStore(base, created.namespaceId).revision).toBe(0);
  });

  it("releases its lock after a successful save", () => {
    const created = createVaultStore(base);
    saveVaultStore(base, created, entries);
    expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
  });

  it("fails as corrupt on truncated JSON without echoing the stored value", () => {
    const created = createVaultStore(base);
    writeFileSync(storeFile(created), `{"revision":0,"entries":[["${REAL}"`, {
      mode: 0o600,
    });
    const error = failure(() => loadVaultStore(base, created.namespaceId));
    expect(error.code).toBe("STORE_CORRUPT");
    expect(error.message).not.toContain(REAL);
  });

  it.each([
    ["a negative revision", { revision: -1, entries: [] }],
    ["a string revision", { revision: "0", entries: [] }],
    ["entries that are not a list", { revision: 0, entries: {} }],
    ["a tuple with three parts", { revision: 0, entries: [[REAL, "a", "b"]] }],
    ["a non-string fake", { revision: 0, entries: [[REAL, 7]] }],
    ["an empty real", { revision: 0, entries: [["", "fake"]] }],
    [
      "a duplicate real",
      {
        revision: 0,
        entries: [
          [REAL, "fake-1"],
          [REAL, "fake-2"],
        ],
      },
    ],
    [
      "a duplicate fake",
      {
        revision: 0,
        entries: [
          [REAL, "fake"],
          ["other", "fake"],
        ],
      },
    ],
  ])("fails as corrupt when the store has %s", (_name, content) => {
    const created = createVaultStore(base);
    writeFileSync(storeFile(created), JSON.stringify(content), { mode: 0o600 });
    const error = failure(() => loadVaultStore(base, created.namespaceId));
    expect(error.code).toBe("STORE_CORRUPT");
    expect(error.message).not.toContain(REAL);
  });

  it("accepts exactly the entry cap and refuses one more on save", () => {
    const created = createVaultStore(base);
    const capped = Array.from({ length: 50000 }, (_, index): VaultEntry => [
      `real-${index}`,
      `fake-${index}`,
    ]);
    expect(saveVaultStore(base, created, capped).revision).toBe(1);
    const overCap = [...capped, ["real-over", "fake-over"] as VaultEntry];
    expect(
      failure(() => saveVaultStore(base, { ...created, revision: 1 }, overCap))
        .code,
    ).toBe("STORE_INVALID");
  });

  it("fails as corrupt when a stored list exceeds the entry cap", () => {
    const created = createVaultStore(base);
    const overCap = Array.from({ length: 50001 }, (_, index) => [
      `real-${index}`,
      `fake-${index}`,
    ]);
    writeFileSync(
      storeFile(created),
      JSON.stringify({ revision: 0, entries: overCap }),
      { mode: 0o600 },
    );
    expect(failure(() => loadVaultStore(base, created.namespaceId)).code).toBe(
      "STORE_CORRUPT",
    );
  });

  it("refuses a store file or directory that is readable by others", () => {
    const created = createVaultStore(base);
    fs.chmodSync(storeFile(created), 0o644);
    expect(failure(() => loadVaultStore(base, created.namespaceId)).code).toBe(
      "STORE_UNSAFE",
    );
    fs.chmodSync(storeFile(created), 0o600);
    fs.chmodSync(base, 0o755);
    expect(failure(() => loadVaultStore(base, created.namespaceId)).code).toBe(
      "STORE_UNSAFE",
    );
  });

  it("refuses a store that is a symbolic link", () => {
    const created = createVaultStore(base);
    const target = join(base, "elsewhere.json");
    fs.renameSync(storeFile(created), target);
    fs.symlinkSync(target, storeFile(created));
    expect(failure(() => loadVaultStore(base, created.namespaceId)).code).toBe(
      "STORE_UNSAFE",
    );
  });

  it("refuses a base directory that is a symbolic link, touching neither side", () => {
    const target = join(base, "..", "real-vaults");
    mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, base);
    const namespaceId = "0".repeat(32);
    expect(failure(() => createVaultStore(base)).code).toBe("STORE_UNSAFE");
    expect(failure(() => loadVaultStore(base, namespaceId)).code).toBe(
      "STORE_UNSAFE",
    );
    expect(
      failure(() => saveVaultStore(base, { namespaceId, revision: 0 }, entries))
        .code,
    ).toBe("STORE_UNSAFE");
    expect(readdirSync(target)).toEqual([]);
  });

  it.skipIf(process.geteuid === undefined)(
    "refuses a store that the current user does not own",
    () => {
      const created = createVaultStore(base);
      const spy = vi
        .spyOn(process, "geteuid")
        .mockReturnValue((process.geteuid?.() ?? 0) + 1);
      try {
        expect(
          failure(() => loadVaultStore(base, created.namespaceId)).code,
        ).toBe("STORE_UNSAFE");
        expect(failure(() => saveVaultStore(base, created, entries)).code).toBe(
          "STORE_UNSAFE",
        );
      } finally {
        spy.mockRestore();
      }
      expect(loadVaultStore(base, created.namespaceId).revision).toBe(0);
    },
  );

  it("keeps the old store and removes its temporary file when a write fails", () => {
    const created = createVaultStore(base);
    faults.writeSync = () => {
      throw ioError("ENOSPC");
    };
    const error = failure(() => saveVaultStore(base, created, entries));
    expect(error.code).toBe("STORE_IO");
    expect(error.message).toContain("ENOSPC");
    expect(error.message).not.toContain(REAL);
    expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
    expect(loadVaultStore(base, created.namespaceId).revision).toBe(0);
  });

  it("completes a partial write before flushing", async () => {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const created = createVaultStore(base);
    let calls = 0;
    faults.writeSync = (fd, buffer, offset, length) => {
      calls++;
      return calls === 1
        ? real.writeSync(fd, buffer, offset, Math.min(length ?? 0, 5))
        : real.writeSync(fd, buffer, offset, length);
    };
    saveVaultStore(base, created, entries);
    expect(calls).toBe(2);
    expect(loadVaultStore(base, created.namespaceId).entries).toEqual(entries);
  });

  it("keeps the old store and removes its temporary file when flushing fails", () => {
    const created = createVaultStore(base);
    faults.fsyncSync = () => {
      throw ioError("EIO");
    };
    expect(failure(() => saveVaultStore(base, created, entries)).code).toBe(
      "STORE_IO",
    );
    expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
    expect(loadVaultStore(base, created.namespaceId).revision).toBe(0);
  });

  it.each([1, 2])(
    "reports a failed save when directory flush %i fails, though the rename may have committed",
    async (failingFlush) => {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      const created = createVaultStore(base);
      let directoryFlushes = 0;
      faults.fsyncSync = (fd) => {
        if (!real.fstatSync(fd).isDirectory()) return real.fsyncSync(fd);
        directoryFlushes++;
        if (directoryFlushes === failingFlush) throw ioError("EIO");
        return real.fsyncSync(fd);
      };
      const error = failure(() => saveVaultStore(base, created, entries));
      expect(error.code).toBe("STORE_IO");
      expect(directoryFlushes).toBe(failingFlush);
      expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
      // Reload shows visibility only; it does not prove the rename reached stable storage.
      const reloaded = loadVaultStore(base, created.namespaceId);
      expect(reloaded.revision).toBe(1);
      expect(reloaded.entries).toEqual(entries);
    },
  );

  it("flushes the directory after releasing the lock, not only before", async () => {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const created = createVaultStore(base);
    const lock = join(base, `${created.namespaceId}.lock`);
    const lockPresentAtFlush: boolean[] = [];
    faults.fsyncSync = (fd) => {
      if (real.fstatSync(fd).isDirectory())
        lockPresentAtFlush.push(fs.existsSync(lock));
      real.fsyncSync(fd);
    };
    saveVaultStore(base, created, entries);
    expect(lockPresentAtFlush).toEqual([true, false]);
  });

  it("keeps the old store and removes its temporary file when the rename fails", () => {
    const created = createVaultStore(base);
    faults.renameSync = () => {
      throw ioError("EXDEV");
    };
    expect(failure(() => saveVaultStore(base, created, entries)).code).toBe(
      "STORE_IO",
    );
    expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
    expect(loadVaultStore(base, created.namespaceId).revision).toBe(0);
  });

  it("leaves no store when publishing a new store fails", () => {
    faults.linkSync = () => {
      throw ioError("EIO");
    };
    expect(failure(() => createVaultStore(base)).code).toBe("STORE_IO");
    expect(readdirSync(base)).toEqual([]);
  });

  it("commits every successful save once when writers overlap", async () => {
    const created = createVaultStore(base);
    const writer = join(base, "..", "writer.mjs");
    writeFileSync(writer, WRITER_SCRIPT);
    const runs = await Promise.all(
      ["a", "b", "c", "d"].map((tag) =>
        execFileAsync(process.execPath, [
          writer,
          base,
          created.namespaceId,
          tag,
          "40",
        ]),
      ),
    );
    const committed = runs.reduce(
      (total, run) => total + Number(run.stdout),
      0,
    );
    const stored = loadVaultStore(base, created.namespaceId);
    expect(committed).toBeGreaterThan(0);
    expect(stored.revision).toBe(committed);
    expect(stored.entries).toHaveLength(committed);
    expect(readdirSync(base)).toEqual([`${created.namespaceId}.json`]);
  }, 30_000);
});
