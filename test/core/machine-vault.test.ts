import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
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

  it("refuses a key that other users can read", () => {
    const dir = stateDir();
    MachineVault.open(dir);
    chmodSync(join(dir, "key"), 0o644);
    expect(() => MachineVault.open(dir)).toThrow(
      expect.objectContaining({ code: "STORE_UNSAFE" }),
    );
  });

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
