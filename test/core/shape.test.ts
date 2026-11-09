import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type RandomBytes, reshape } from "../../src/core/shape.ts";

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

function classOf(char: string): string {
  if (/[0-9]/.test(char)) return "d";
  if (/[A-Z]/.test(char)) return "U";
  if (/[a-z]/.test(char)) return "l";
  return char;
}

describe("reshape", () => {
  it("hides caseless letters and non-ASCII numbers without changing UTF-16 width", () => {
    for (const value of ["中文", "العربية", "１２٣", "𐐀", "𝟎𝟙"]) {
      const fake = reshape(value, seeded(value));
      expect(fake).toHaveLength(value.length);
      expect(fake).toMatch(/^[A-Za-z0-9]+$/);
      expect(fake).not.toBe(value);
    }
  });
  it("keeps length, character classes and punctuation", () => {
    const source = seeded("classes");
    for (const value of [
      "Abc-123_xyz@example.com",
      "ORD-123456",
      "/Users/someone/project",
      "p4ss w0rd!",
    ]) {
      const fake = reshape(value, source);
      expect(fake).toHaveLength(value.length);
      expect([...fake].map(classOf)).toEqual([...value].map(classOf));
    }
  });

  it("keeps hex values hex and keeps uuid layout", () => {
    const source = seeded("hex");
    const uuid = "3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f";
    for (let i = 0; i < 50; i++) {
      const fake = reshape(uuid, source);
      expect(fake).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(reshape("DEADBEEF01", source)).toMatch(/^[0-9A-F]{10}$/);
  });

  it("keeps IPv4 addresses valid, with the same octet widths", () => {
    const source = seeded("ipv4");
    for (let i = 0; i < 300; i++) {
      const octets = reshape("203.0.113.45", source).split(".");
      expect(octets.map((octet) => octet.length)).toEqual([3, 1, 3, 2]);
      for (const octet of octets)
        expect(Number(octet)).toBeLessThanOrEqual(255);
    }
  });

  it("never gives a digit run a new leading zero", () => {
    const source = seeded("digits");
    for (let i = 0; i < 200; i++) {
      const fake = reshape("9123456 0789", source);
      expect(fake[0]).not.toBe("0");
      expect(fake[8]).toBe("0");
    }
  });

  it("replaces non-ASCII letters with ASCII letters of the same case", () => {
    const fake = reshape("Élodie", seeded("accents"));
    expect(fake).toMatch(/^[A-Z][a-z]{5}$/);
  });

  it("varies with crypto bytes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++)
      seen.add(reshape("secret-value-42", randomBytes));
    expect(seen.size).toBeGreaterThan(15);
  });
});
