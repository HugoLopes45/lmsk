import crypto from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import fs, {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { MachineVault } from "../../src/core/machine-vault.ts";

function stateDir(): string {
  return join(mkdtempSync(join(tmpdir(), "lmsk-machine-")), "lmsk");
}

/** Assigns `real` the way a mask does: inside the vault's transaction. */
function fakeIn(machine: MachineVault, real: string): string {
  const [fake] = machine.vault.atomic(() => [machine.vault.fakeFor(real, "")]);
  return fake;
}

function fixedIn(machine: MachineVault, name: string): string {
  const [fake] = machine.vault.atomic(() => [
    machine.vault.fixedFor(name, "Client{n}", ""),
  ]);
  return fake;
}

describe("MachineVault", () => {
  it("creates a private directory, key and journal", () => {
    const dir = stateDir();
    MachineVault.open(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "key")).size).toBe(32);
    expect(statSync(join(dir, "vault.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("restores a fake of an earlier process", () => {
    const dir = stateDir();
    const fake = fakeIn(MachineVault.open(dir), "ghp_0123456789abcdefghij");
    expect(MachineVault.open(dir).vault.restore(`x ${fake} y`)).toBe(
      "x ghp_0123456789abcdefghij y",
    );
  });

  it("gives a real the fake of a process that runs at the same time", () => {
    const dir = stateDir();
    const first = MachineVault.open(dir);
    const second = MachineVault.open(dir);
    const fake = fakeIn(first, "s3cretValue-0001");
    expect(fakeIn(second, "s3cretValue-0001")).toBe(fake);
  });

  it("numbers the names of two processes that run at the same time apart", () => {
    const dir = stateDir();
    const first = MachineVault.open(dir);
    const second = MachineVault.open(dir);
    expect(fixedIn(first, "Acme")).toBe("Client1");
    expect(fixedIn(second, "Globex")).toBe("Client2");
  });

  it("keeps one fake per real and one real per fake whatever two processes learn in turn", () => {
    const step = fc.record({
      process: fc.boolean(),
      name: fc.constantFrom("Acme", "Globex", "Initech", "Umbrella"),
      secret: fc.stringMatching(/^[A-Za-z0-9]{12}$/),
      fixed: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 20 }), (steps) => {
        const dir = stateDir();
        const machines = [MachineVault.open(dir), MachineVault.open(dir)];
        for (const { process, name, secret, fixed } of steps) {
          const machine = machines[process ? 1 : 0];
          if (fixed) fixedIn(machine, name);
          else fakeIn(machine, secret);
        }
        const entries = MachineVault.open(dir).vault.entries();
        expect(new Set(entries.map(([real]) => real)).size).toBe(
          entries.length,
        );
        expect(new Set(entries.map(([, fake]) => fake)).size).toBe(
          entries.length,
        );
      }),
      { numRuns: 30 },
    );
  });

  it("keeps the reals of a tool call for every process", () => {
    const dir = stateDir();
    const first = MachineVault.open(dir);
    const second = MachineVault.open(dir);
    first.recordCall("toolu_01", ["hunter2"]);
    expect(second.realsOf(["toolu_02", "toolu_01"])).toEqual(["hunter2"]);
    expect(MachineVault.open(dir).realsOf(["toolu_01"])).toEqual(["hunter2"]);
  });

  it("keeps every record of a call id, in this process and in the next", () => {
    const dir = stateDir();
    const vault = MachineVault.open(dir);
    vault.recordCall("call_1", ["hunter2"]);
    vault.recordCall("call_1", ["tiger7"]);
    expect(vault.realsOf(["call_1"])).toEqual(["hunter2", "tiger7"]);
    expect(MachineVault.open(dir).realsOf(["call_1"])).toEqual([
      "hunter2",
      "tiger7",
    ]);
  });

  it("refuses a journal with an invalid line", () => {
    const dir = stateDir();
    MachineVault.open(dir);
    appendFileSync(join(dir, "vault.jsonl"), "{not json}\n");
    expect(() => MachineVault.open(dir)).toThrow(
      expect.objectContaining({ code: "STORE_CORRUPT" }),
    );
  });

  it("refuses a journal that maps one fake to two reals", () => {
    const dir = stateDir();
    MachineVault.open(dir);
    appendFileSync(
      join(dir, "vault.jsonl"),
      '{"r":"real-one-1","f":"fake-0001"}\n{"r":"real-two-2","f":"fake-0001"}\n',
    );
    expect(() => MachineVault.open(dir)).toThrow(
      expect.objectContaining({ code: "VAULT_COLLISION" }),
    );
  });

  it.each([
    ["an invalid line", "{not json}\n", "STORE_CORRUPT"],
    [
      "a mapping that reuses a fake",
      '{"r":"real-one-1","f":"fake-0001"}\n{"r":"real-two-2","f":"fake-0001"}\n',
      "VAULT_COLLISION",
    ],
  ])("keeps refusing %s that another process appends", (_, lines, code) => {
    const dir = stateDir();
    const vault = MachineVault.open(dir);
    appendFileSync(join(dir, "vault.jsonl"), lines);
    const read = () => vault.realsOf([]);
    expect(read).toThrow(expect.objectContaining({ code }));
    // A read that skips the refused lines would mask without them.
    expect(read).toThrow(expect.objectContaining({ code }));
  });

  it.each([
    ["after a whole character", '{"r":"s3cretValue-00'],
    ["inside a character", Buffer.from('{"r":"s3crétValué').subarray(0, -1)],
  ])(
    "cuts a torn last line that ends %s before it saves new mappings",
    (_, torn) => {
      const dir = stateDir();
      const first = fakeIn(MachineVault.open(dir), "s3cretValue-0004");
      appendFileSync(join(dir, "vault.jsonl"), torn);
      const second = fakeIn(MachineVault.open(dir), "s3cretValue-0005");
      expect(MachineVault.open(dir).vault.restore(`${first} ${second}`)).toBe(
        "s3cretValue-0004 s3cretValue-0005",
      );
    },
  );

  it("does not join a torn line that another process cuts to the next line", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    appendFileSync(
      join(dir, "vault.jsonl"),
      '{"r":"torn-value-that-is-longer-than-the-next-line',
    );
    const read = fs.readSync;
    let reads = 0;
    let fake = "";
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      reads += 1;
      if (reads > 100) throw new Error("The read did not stop at the end");
      if (reads > 1) return read(...args);
      read(...args);
      // Another process cuts the torn line during this read, which gets only its start.
      fake = fakeIn(MachineVault.open(dir), "s3cretValue-0005");
      return '{"r":"torn'.length;
    });
    syncBuiltinESMExports();
    try {
      machine.realsOf([]);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    machine.realsOf([]);
    expect(machine.vault.restore(fake)).toBe("s3cretValue-0005");
  });

  it.each([
    ["at the end of a line", 0],
    ["inside a line", 5],
  ])("keeps the lines after a short read %s under the lock", (_, extra) => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    const other = MachineVault.open(dir);
    const reals = ["s3cretValue-0001", "s3cretValue-0002", "s3cretValue-0003"];
    const fakes = reals.map((real) => fakeIn(other, real));
    const line =
      readFileSync(join(dir, "vault.jsonl"), "utf8").indexOf("\n") + 1;
    const read = fs.readSync;
    let reads = 0;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      reads += 1;
      const count = read(...args);
      // A read of a file can return fewer bytes than it asked for.
      return reads === 1 ? line + extra : count;
    });
    syncBuiltinESMExports();
    try {
      fakes.push(fakeIn(machine, "s3cretValue-0004"));
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    expect(MachineVault.open(dir).vault.restore(fakes.join(" "))).toBe(
      [...reals, "s3cretValue-0004"].join(" "),
    );
  });

  it("stops a read under the lock at the end of a file that got shorter", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    const other = MachineVault.open(dir);
    const kept = fakeIn(other, "s3cretValue-0001");
    const journal = join(dir, "vault.jsonl");
    const start = readFileSync(journal);
    fakeIn(other, "s3cretValue-0002");
    const read = fs.readSync;
    let reads = 0;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      reads += 1;
      if (reads > 100) throw new Error("The read did not stop at the end");
      // Another program cuts the file after this read got its size.
      if (reads === 1) writeFileSync(journal, start);
      return read(...args);
    });
    syncBuiltinESMExports();
    let fake = "";
    try {
      fake = fakeIn(machine, "s3cretValue-0004");
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    expect(MachineVault.open(dir).vault.restore(`${kept} ${fake}`)).toBe(
      "s3cretValue-0001 s3cretValue-0004",
    );
  });

  it("refuses a save after the vault file lost lines that this process read", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    fakeIn(machine, "s3cretValue-0004");
    const journal = join(dir, "vault.jsonl");
    expect(() =>
      machine.vault.atomic(() => {
        writeFileSync(journal, "");
        return [machine.vault.fakeFor("s3cretValue-0005", "")];
      }),
    ).toThrow(expect.objectContaining({ code: "STORE_CORRUPT" }));
    expect(readFileSync(journal, "utf8")).toBe("");
  });

  it("refuses a read after the vault file lost lines that this process read", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    fakeIn(machine, "s3cretValue-0004");
    writeFileSync(join(dir, "vault.jsonl"), "");
    expect(() => machine.realsOf([])).toThrow(
      expect.objectContaining({ code: "STORE_CORRUPT" }),
    );
  });

  it("refuses a save after another program added a line under the lock", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    fakeIn(machine, "s3cretValue-0004");
    const journal = join(dir, "vault.jsonl");
    const before = readFileSync(journal, "utf8");
    const line = `${JSON.stringify({ c: "call-1", r: ["s3cretValue-0001"] })}\n`;
    expect(() =>
      machine.vault.atomic(() => {
        appendFileSync(journal, line);
        return [machine.vault.fakeFor("s3cretValue-0005", "")];
      }),
    ).toThrow(expect.objectContaining({ code: "STORE_CORRUPT" }));
    expect(readFileSync(journal, "utf8")).toBe(before + line);
  });

  it("refuses a save that makes the vault file larger than 32 MiB", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    const empty = `${JSON.stringify({ c: "big", r: [""] })}\n`;
    appendFileSync(
      join(dir, "vault.jsonl"),
      `${JSON.stringify({ c: "big", r: ["x".repeat(32 * 1024 * 1024 - empty.length - 10)] })}\n`,
    );
    expect(() => machine.recordCall("next", ["s3cretValue-0004"])).toThrow(
      expect.objectContaining({ code: "VAULT_FULL" }),
    );
    expect(statSync(join(dir, "vault.jsonl")).size).toBe(32 * 1024 * 1024 - 10);
  });

  it("refuses a key that other users can read", () => {
    const dir = stateDir();
    MachineVault.open(dir);
    chmodSync(join(dir, "key"), 0o644);
    expect(() => MachineVault.open(dir)).toThrow(
      expect.objectContaining({ code: "STORE_UNSAFE" }),
    );
  });

  it.each([
    ["file", "held"],
    ["directory", "held"],
    ["file", "publishing"],
    ["directory", "publishing"],
  ])(
    "keeps a replacement owner exclusive when a stale %s reclaimer resumes during %s",
    async (kind, window) => {
      const dir = stateDir();
      MachineVault.open(dir);
      const gates = new Int32Array(
        new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
      );
      const source = new URL("../../src/core/machine-vault.ts", import.meta.url)
        .href;
      const script = `
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const { join, dirname } = require("node:path");
      const { syncBuiltinESMExports } = require("node:module");
      const gates = new Int32Array(workerData.gates);
      const wait = Atomics.wait;
      const unlink = fs.unlinkSync;
      const open = fs.openSync;
      const lock = join(workerData.dir, "vault.lock");
      let paused = false;
      let armed = false;
      fs.unlinkSync = (path) => {
        if (workerData.slow && armed && !paused && (path === lock || dirname(path) === lock)) {
          paused = true;
          parentPort.postMessage("observed stale lock");
          if (wait(gates, 2, 0, 5000) === "timed-out") throw new Error("Reclaimer was not resumed");
        }
        return unlink(path);
      };
      fs.openSync = (path, ...args) => {
        if (!workerData.slow && armed && workerData.window === "publishing" && dirname(path) === lock) {
          parentPort.postMessage("publishing owner");
          if (wait(gates, 3, 0, 5000) === "timed-out") throw new Error("Publisher was not released");
        }
        return open(path, ...args);
      };
      Atomics.wait = (array, index, value, timeout) => {
        if (workerData.slow && paused && array.buffer !== workerData.gates)
          parentPort.postMessage("waiting for owner");
        return wait(array, index, value, timeout);
      };
      syncBuiltinESMExports();
      import(workerData.source).then(({ MachineVault }) => {
        const machine = MachineVault.open(workerData.dir);
        parentPort.postMessage("ready");
        if (wait(gates, workerData.slow ? 0 : 1, 0, 5000) === "timed-out")
          throw new Error("Writer was not started");
        armed = true;
        machine.vault.atomic(() => {
          if (Atomics.add(gates, 4, 1) !== 0) Atomics.store(gates, 5, 1);
          try {
            parentPort.postMessage("entered");
            if (!workerData.slow && workerData.window === "held" && wait(gates, 3, 0, 5000) === "timed-out")
              throw new Error("Owner was not released");
            return [machine.vault.fixedFor(workerData.slow ? "Acme" : "Globex", "Client{n}", "")];
          } finally {
            Atomics.sub(gates, 4, 1);
          }
        });
        parentPort.close();
      });
    `;
      const launch = (slow: boolean) =>
        new Worker(script, {
          eval: true,
          workerData: { dir, source, slow, window, gates: gates.buffer },
        });
      const release = (index: number) => {
        Atomics.store(gates, index, 1);
        Atomics.notify(gates, index);
      };
      const slow = launch(true);
      const slowExit = once(slow, "exit").then(
        ([code]) => code,
        (error: unknown) => error,
      );
      let fast: Worker | undefined;
      try {
        await once(slow, "message");
        fast = launch(false);
        const fastExit = once(fast, "exit").then(
          ([code]) => code,
          (error: unknown) => error,
        );
        await once(fast, "message");
        const lock = join(dir, "vault.lock");
        if (kind === "file") writeFileSync(lock, "999999999", { mode: 0o600 });
        else {
          mkdirSync(lock, 0o700);
          writeFileSync(join(lock, `999999999-${"a".repeat(32)}`), "", {
            mode: 0o600,
          });
        }
        const observed = once(slow, "message");
        release(0);
        await observed;
        const entered = once(fast, "message");
        release(1);
        await entered;
        const resumed = once(slow, "message");
        release(2);
        await resumed;
        expect(Atomics.load(gates, 5)).toBe(0);
        release(3);
        expect(await Promise.all([slowExit, fastExit])).toEqual([0, 0]);
        expect(
          MachineVault.open(dir)
            .vault.entries()
            .map(([real]) => real)
            .sort(),
        ).toEqual(["Acme", "Globex"]);
      } finally {
        for (const index of [0, 1, 2, 3]) release(index);
        await slow.terminate();
        if (fast !== undefined) await fast.terminate();
      }
    },
  );

  it.each([
    [],
    ["unknown-owner"],
    [`999999999-${"a".repeat(32)}`, `999999999-${"b".repeat(32)}`],
  ])("refuses a lock directory without one known owner: %j", (...owners) => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    const lock = join(dir, "vault.lock");
    mkdirSync(lock, 0o700);
    for (const owner of owners)
      writeFileSync(join(lock, owner), "", { mode: 0o600 });
    expect(() => fixedIn(machine, "Acme")).toThrow(
      expect.objectContaining({ code: "STORE_BUSY" }),
    );
    expect(machine.vault.entries()).toEqual([]);
  });

  it.each(["random", "open", "close"])(
    "releases an unpublished lock after an owner %s error",
    (operation) => {
      const dir = stateDir();
      const machine = MachineVault.open(dir);
      const lock = join(dir, "vault.lock");
      const open = fs.openSync;
      const close = fs.closeSync;
      let ownerFd: number | undefined;
      let failed = false;
      if (operation === "random")
        vi.spyOn(crypto, "randomBytes").mockImplementationOnce(() => {
          throw Object.assign(new Error("Owner randomness failed"), {
            code: "EIO",
          });
        });
      vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        const owner = typeof path === "string" && path.startsWith(`${lock}/`);
        if (owner && operation === "open" && !failed) {
          failed = true;
          throw Object.assign(new Error("Owner creation failed"), {
            code: "EMFILE",
          });
        }
        const fd = open(path, flags, mode);
        if (owner) ownerFd = fd;
        return fd;
      });
      vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        close(fd);
        if (fd === ownerFd && operation === "close" && !failed) {
          failed = true;
          throw Object.assign(new Error("Owner close failed"), { code: "EIO" });
        }
      });
      syncBuiltinESMExports();
      try {
        expect(() => fixedIn(machine, "Acme")).toThrow(
          expect.objectContaining({ code: "STORE_IO" }),
        );
        expect(fixedIn(machine, "Acme")).toBe("Client1");
        expect(fs.existsSync(lock)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
      }
    },
  );

  it.each([false, true])(
    "refuses reentrant writes without releasing the current owner (sibling=%s)",
    (sibling) => {
      const dir = stateDir();
      const machine = MachineVault.open(dir);
      const nested = sibling ? MachineVault.open(dir) : machine;
      const [fake] = machine.vault.atomic(() => {
        expect(() => fixedIn(nested, "Globex")).toThrow(
          expect.objectContaining({ code: "STORE_BUSY" }),
        );
        return [machine.vault.fixedFor("Acme", "Client{n}", "")];
      });
      expect(MachineVault.open(dir).vault.restore(fake)).toBe("Acme");
      expect(fixedIn(nested, "Globex")).toBe("Client2");
    },
  );

  it("takes over the lock of a process that ended", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    writeFileSync(join(dir, "vault.lock"), "999999999", { mode: 0o600 });
    expect(fakeIn(machine, "s3cretValue-0002")).toHaveLength(16);
  });

  it("blocks while a live process holds the lock", () => {
    const dir = stateDir();
    const machine = MachineVault.open(dir);
    writeFileSync(join(dir, "vault.lock"), String(process.ppid), {
      mode: 0o600,
    });
    expect(() => fakeIn(machine, "s3cretValue-0003")).toThrow(
      expect.objectContaining({ code: "STORE_BUSY" }),
    );
    expect(readFileSync(join(dir, "vault.jsonl"), "utf8")).toBe("");
  });
});
