import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RandomBytes } from "../../src/core/shape.ts";
import { Vault, type VaultEntry } from "../../src/core/vault.ts";
import fc from "fast-check";

function seeded(seed: string): RandomBytes {
  let counter = 0;
  return (size) => {
    let bytes = Buffer.alloc(0);
    while (bytes.length < size)
      bytes = Buffer.concat([
        bytes,
        createHash("sha256").update(`${seed}${counter++}`).digest(),
      ]);
    return bytes.subarray(0, size);
  };
}

/** Bytes in order, repeating; each call returns the next byte per position. */
function sequence(bytes: number[]): RandomBytes {
  let index = 0;
  return (size) =>
    Uint8Array.from({ length: size }, () => bytes[index++ % bytes.length] ?? 0);
}

describe("Vault", () => {
  it("rolls back both maps and restore patterns while preserving encoded mappings", () => {
    const vault = new Vault(seeded("rollback"), [["REAL-0001", "FAKE-0001"]]);
    vault.bindRun("%53%45", "%56%55", "");
    const before = vault.entries();
    expect(vault.restore("FAKE-0001 %56%55")).toBe("REAL-0001 %53%45");
    let added = "";
    expect(() =>
      vault.atomic(() => {
        added = vault.fakeFor("SECRET-NEW", "");
        vault.bindRun("%41%42", "%58%59", "");
        expect(vault.restore(added)).toBe("SECRET-NEW");
        throw new Error("render failed");
      }),
    ).toThrow("render failed");
    expect(vault.entries()).toEqual(before);
    expect(vault.realOf(added)).toBeUndefined();
    expect(vault.realOf("%58%59")).toBeUndefined();
    expect(vault.restore(added)).toBe(added);
    expect(vault.restore("FAKE-0001 %56%55")).toBe("REAL-0001 %53%45");
  });
  it.each([
    { label: "empty real", entries: [["", "FAKE-0001"]] },
    { label: "empty fake", entries: [["REAL-0001", ""]] },
    { label: "equal real and fake", entries: [["REAL-0001", "REAL-0001"]] },
  ])("rejects restored $label", ({ entries }) => {
    const pairs: VaultEntry[] = entries.map(([real, fake]) => [real, fake]);
    expect(() => new Vault(seeded("invalid-reload"), pairs)).toThrow(
      /^VAULT_COLLISION/,
    );
  });

  it("rejects restored entries beyond the vault cap", () => {
    const entries: VaultEntry[] = Array.from({ length: 50001 }, (_, index) => [
      `r${index}`,
      `f${index}`,
    ]);
    expect(() => new Vault(seeded("reload-cap"), entries)).toThrow(
      /^VAULT_FULL/,
    );
  });

  it("rejects generated duplicate reload mappings", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z]{12}$/), (value) => {
        expect(
          () =>
            new Vault(seeded("duplicate-real"), [
              [value, "fake-1"],
              [value, "fake-2"],
            ]),
        ).toThrow(/^VAULT_COLLISION/);
        expect(
          () =>
            new Vault(seeded("duplicate-fake"), [
              ["real-1", value],
              ["real-2", value],
            ]),
        ).toThrow(/^VAULT_COLLISION/);
      }),
      { seed: 741527, numRuns: 100 },
    );
  });
  it("rejects restored entries that assign the same fake to different reals", () => {
    expect(
      () =>
        new Vault(seeded("hostile-reload"), [
          ["REAL-0001", "FAKE-0001"],
          ["REAL-0002", "FAKE-0001"],
        ]),
    ).toThrow(/^VAULT_COLLISION/);
  });
  it("returns the same fake for the same real, and a fake that differs from the real", () => {
    const vault = new Vault(seeded("same"));
    const fake = vault.fakeFor("Secret-1234", "");
    expect(vault.fakeFor("Secret-1234", "")).toBe(fake);
    expect(fake).not.toBe("Secret-1234");
    expect(fake).toHaveLength("Secret-1234".length);
  });

  it("avoids a fake that already occurs in the text being masked", () => {
    const first = new Vault(seeded("avoid")).fakeFor("Secret-1234", "");
    const fake = new Vault(seeded("avoid")).fakeFor("Secret-1234", first);
    expect(fake).not.toBe(first);
  });

  it("never gives a fake that contains an existing fake", () => {
    // Upper-case letters 23, 24 make "XY"; 23, 24, 25 would make "XYZ", which contains "XY".
    const vault = new Vault(sequence([23, 24, 23, 24, 25, 0, 1, 2]));
    const fakeA = vault.fakeFor("aa", "");
    const fakeB = vault.fakeFor("bbb", "");
    expect(fakeA).toBe("XY");
    expect(fakeB).not.toContain(fakeA);
  });

  it("throws VAULT_COLLISION when every candidate equals the real", () => {
    const zeros: RandomBytes = (size) => new Uint8Array(size);
    expect(() => new Vault(zeros).fakeFor("AAAA", "")).toThrow(
      /^VAULT_COLLISION/,
    );
  });

  it("binds an encoded run to its rendering and restores the run as written", () => {
    const vault = new Vault(seeded("run"));
    vault.bindRun("%53%45", "%56%55", "");
    expect(vault.restore("x %56%55 y")).toBe("x %53%45 y");
  });

  it("throws VAULT_COLLISION when a rendering is already a fake", () => {
    const vault = new Vault(seeded("run"));
    vault.bindRun("%53%45", "%56%55", "");
    expect(() => vault.bindRun("%41%42", "%56%55", "")).toThrow(
      /^VAULT_COLLISION/,
    );
  });

  it("throws VAULT_FULL once the vault holds 50000 entries", () => {
    const entries = Array.from(
      { length: 50000 },
      (_, index): [string, string] => [`real${index}`, `fake${index}`],
    );
    expect(() =>
      new Vault(seeded("full"), entries).fakeFor("new-value", ""),
    ).toThrow(/^VAULT_FULL/);
  });

  it("restores a fake that sits next to punctuation", () => {
    const vault = new Vault(seeded("punctuation"));
    const fake = vault.fakeFor("Alpha1234", "");
    expect(vault.restore(`(${fake}), x=${fake}`)).toBe(
      "(Alpha1234), x=Alpha1234",
    );
  });

  it("does not restore two fakes glued inside one token", () => {
    const vault = new Vault(seeded("glued"));
    const first = vault.fakeFor("Alpha1234", "");
    const second = vault.fakeFor("Bravo5678", "");
    expect(vault.restore(first + second)).toBe(first + second);
  });

  it("restores a session from its entries", () => {
    const original = new Vault(seeded("session"));
    const fake = original.fakeFor("Secret-1234", "");
    const restored = new Vault(seeded("other"), original.entries());
    expect(restored.restore(`id ${fake}`)).toBe("id Secret-1234");
    expect(restored.fakeFor("Secret-1234", "")).toBe(fake);
  });
});

describe("Vault placeholders", () => {
  it("gives an opaque fake of the same length with only letters and digits", () => {
    const fake = new Vault(seeded("opaque")).fakeFor("192.168.1.10", "");
    expect(fake).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  it("restores a fake of a fake once, to the fake it names", () => {
    const vault = new Vault(seeded("chain"), [
      ["Secret-1234", "Qx7Lp9Vb2Nm4"],
      ["Qx7Lp9Vb2Nm4", "Hk3Wd8Rt5Ys1"],
    ]);
    expect(vault.restore("Hk3Wd8Rt5Ys1")).toBe("Qx7Lp9Vb2Nm4");
  });
});

describe("Vault fixed fakes", () => {
  it("gives the variants of one name one number in the shape of each variant", () => {
    const vault = new Vault(seeded("entity"));
    const fakes = [
      "AcmeCorp",
      "ACMECORP",
      "acmecorp",
      "Acme Corp",
      "acme-corp",
    ].map((real) => vault.fixedFor(real, "Client{n}", ""));
    fakes.push(
      vault.fixedFor("AcmeCorpTheme", "Client{n}", "", [0, 8]),
      vault.fixedFor("acmecorpcode", "Client{n}", "", [0, 8]),
    );
    expect(fakes).toEqual([
      "Client1",
      "CLIENT1",
      "client1",
      "Client 1",
      "client-1",
      "Client1Theme",
      "client1code",
    ]);
    expect(vault.fixedFor("Globex", "Client{n}", "")).toBe("Client2");
    expect(vault.restore(fakes.join(" | "))).toBe(
      "AcmeCorp | ACMECORP | acmecorp | Acme Corp | acme-corp | AcmeCorpTheme | acmecorpcode",
    );
  });

  it("keeps the number of a name after a reload", () => {
    const first = new Vault(seeded("entity"));
    first.fixedFor("Globex", "Client{n}", "");
    first.fixedFor("AcmeCorpTheme", "Client{n}", "", [0, 8]);
    const vault = new Vault(seeded("reload"), first.entries());
    expect(vault.fixedFor("ACME-CORP", "Client{n}", "", [0, 9])).toBe(
      "CLIENT-2",
    );
  });

  it("uses the number of a name when a longer fake of it is in the text", () => {
    const vault = new Vault(seeded("entity"));
    vault.fixedFor("AcmeCorpTheme", "Client{n}", "", [0, 8]);
    expect(
      vault.fixedFor("AcmeCorp", "Client{n}", "import Client1Theme", [0, 8]),
    ).toBe("Client1");
  });

  it("numbers a fixed fake without a name apart from an opaque fake that holds its template", () => {
    const vault = new Vault(seeded("entity"), [
      ["Rk7pQ2mZ4xLw", "Ab3c7Xy9QwEr"],
    ]);
    expect(vault.fixedFor("Globex", "C{n}", "")).toBe("C1");
  });

  it("gives a new number to a variant whose shape another variant has", () => {
    const vault = new Vault(seeded("entity"));
    vault.fixedFor("AcmeCorp", "Client{n}", "");
    expect(vault.fixedFor("Acmecorp", "Client{n}", "")).toBe("Client2");
    expect(vault.restore("Client1 Client2")).toBe("AcmeCorp Acmecorp");
  });
});
