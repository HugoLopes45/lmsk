import { createHash } from "node:crypto";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RegexRule,
  mergeConfigs,
  validateConfig,
} from "../../src/core/config.ts";
import { PII_RULES } from "../../src/core/pii-rules.ts";
import { type ScanPattern, Scanner } from "../../src/core/scanner.ts";

let scanner: Scanner | undefined;
afterEach(() => scanner?.close());

/** Values the PII rule `id` finds in `text`. */
async function found(id: string, text: string): Promise<string[]> {
  const rule = PII_RULES.find((candidate) => candidate.id === id);
  if (rule?.type !== "regex") throw new Error(`no regex rule ${id}`);
  const pattern: ScanPattern = {
    source: rule.pattern,
    flags: rule.flags,
    group: rule.group,
    validate: rule.validate,
  };
  scanner?.close();
  scanner = new Scanner(1000);
  const [spans = []] = await scanner.scan([pattern], [text]);
  return spans.map(([start, end]) => text.slice(start, end));
}

/** Deterministic digits, built at run time so no literal number is checksum-valid by accident. */
function digits(seed: string, count: number): string {
  let out = "";
  for (let block = 0; out.length < count; block++)
    for (const byte of createHash("sha256").update(`${seed}/${block}`).digest())
      out += String(byte % 10);
  return out.slice(0, count);
}

/** Letters count as 10 to 35, as in the IBAN check. */
function mod97(value: string): number {
  let remainder = 0;
  for (const char of value)
    for (const digit of String(parseInt(char, 36)))
      remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder;
}

function iban(country: string, bban: string): string {
  const check = 98 - mod97(`${bban}${country}00`);
  return `${country}${String(check).padStart(2, "0")}${bban}`;
}

function grouped(value: string, size: number): string {
  return value.replace(new RegExp(`(.{${size}})(?=.)`, "g"), "$1 ");
}

/** Appends the Luhn check digit to a card body. */
function luhnCard(body: string): string {
  let sum = 0;
  [...body].reverse().forEach((char, index) => {
    const doubled = index % 2 === 0 ? Number(char) * 2 : Number(char);
    sum += doubled > 9 ? doubled - 9 : doubled;
  });
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** Appends the French NIR key; Corsica 2A and 2B count as 19 and 18. */
function nir(body: string): string {
  const number = Number(body.replace("2A", "19").replace("2B", "18"));
  return `${body}${String(97 - (number % 97)).padStart(2, "0")}`;
}

/** Changes the last digit so that the checksum fails. */
function lastDigitOff(value: string): string {
  const last = Number(value.at(-1));
  return `${value.slice(0, -1)}${(last + 1) % 10}`;
}

describe("email", () => {
  it("finds an address in prose", async () => {
    expect(
      await found("email", "write to ada.lovelace@example.com today"),
    ).toEqual(["ada.lovelace@example.com"]);
  });

  it("keeps image names and npm packages", async () => {
    expect(
      await found(
        "email",
        "logo icon@2x.png, @angular/core@17.2.0, @scope/pkg",
      ),
    ).toEqual([]);
  });

  it("keeps the git remote user, which names a service, not a person", async () => {
    expect(
      await found(
        "email",
        "origin git@github.com:acme/app.git, ssh://git@github.com/acme/app",
      ),
    ).toEqual([]);
  });
});

describe("phone numbers", () => {
  it("finds French numbers with +33 or 0, and spaces, dots or dashes", async () => {
    expect(
      await found(
        "phone-fr",
        "call +33 6 12 48 93 27 or 06.12.48.93.27 or 07-81-55-20-64",
      ),
    ).toEqual(["+33 6 12 48 93 27", "06.12.48.93.27", "07-81-55-20-64"]);
  });

  it("keeps dates, timestamps, ports, versions and long ids", async () => {
    const text =
      "built 2024-06-12 10:30:00 on port 0443 version 1.2.3 id 0612345678901";
    expect(await found("phone-fr", text)).toEqual([]);
    expect(await found("phone-us", text)).toEqual([]);
    expect(await found("phone-e164", text)).toEqual([]);
  });

  it("finds US numbers with +1 or parentheses", async () => {
    expect(
      await found("phone-us", "+1 (235) 534-1027 or (555) 123-4567"),
    ).toEqual(["+1 (235) 534-1027", "(555) 123-4567"]);
  });

  it("finds international numbers with a + and separators", async () => {
    expect(
      await found(
        "phone-e164",
        "+44 7117 850541, +49 151 46734463 and +33612345678",
      ),
    ).toEqual(["+44 7117 850541", "+49 151 46734463", "+33612345678"]);
  });

  it("keeps a plus inside code and identifiers", async () => {
    expect(await found("phone-e164", "C++11 and x+1234567890")).toEqual([]);
  });
});

describe("iban", () => {
  it("finds a valid IBAN with or without spaces", async () => {
    const fr = iban("FR", digits("fr", 23));
    const gb = iban("GB", `NWBK${digits("gb", 14)}`);
    expect(await found("iban", `${grouped(fr, 4)} and ${gb}`)).toEqual([
      grouped(fr, 4),
      gb,
    ]);
  });

  it("keeps an IBAN whose check digits fail", async () => {
    expect(
      await found("iban", lastDigitOff(iban("DE", digits("de", 18)))),
    ).toEqual([]);
  });
});

describe("credit card", () => {
  it("keeps a contextual 4000 code when the next full card is separate", async () => {
    expect(
      await found(
        "credit-card",
        "card=5156 3777 8930 3107 4000 4000 4000 0000 0000 002",
      ),
    ).toEqual(["5156 3777 8930 3107 4000", "4000 4000 0000 0000 002"]);
  });

  it("keeps whole contextual cards despite checksum-valid inner groups", async () => {
    const value = "5156 3777 4000 3101 0006 4000 0000 0000 6";
    expect(await found("credit-card", `card=${value}`)).toEqual([
      "5156 3777 4000 3101 0006",
      "4000 0000 0000 6",
    ]);
  });

  it("does not validate an invalid contextual PAN through the whole PAN-plus-code checksum", async () => {
    expect(await found("credit-card", "card=5156 3777 8930 3109 4000")).toEqual(
      [],
    );
  });
  it("does not consume a following card group when its remainder also has a card shape", async () => {
    expect(
      await found(
        "credit-card",
        "card=5156 3777 8930 3107 4000 4000 0000 0000 002",
      ),
    ).toEqual(["5156 3777 8930 3107", "4000 4000 0000 0000 002"]);
  });
  it.each(["123", "412", "512", "634"])(
    "keeps the ambiguous invalid run intact but finds the next card after code %s",
    async (code) => {
      const text = `4271 5686 2827 7212 ${code} 5156 3777 8930 3107`;
      expect(await found("credit-card", text)).toEqual(["5156 3777 8930 3107"]);
    },
  );

  it("never validates a bare long card through its checksum-valid prefix", async () => {
    for (const text of ["4271568628277212123", "4271 5686 2827 7212 123"]) {
      expect(await found("credit-card", text)).toEqual([]);
    }
  });

  it("masks the PAN without treating five extra digits as a security code", async () => {
    expect(await found("credit-card", "4054 1570 2354 5911 12345")).toEqual([
      "4054 1570 2354 5911",
    ]);
  });

  it("covers contextual PAN and code pairs across generated layouts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          { prefix: "4", length: 13 },
          { prefix: "4", length: 16 },
          { prefix: "4", length: 19 },
          { prefix: "52", length: 16 },
          { prefix: "37", length: 15 },
          { prefix: "6011", length: 19 },
        ),
        fc.nat({ max: 999999 }),
        fc.integer({ min: 0, max: 9999 }),
        fc.boolean(),
        async ({ prefix, length }, seed, number, spaced) => {
          const pan = luhnCard(
            prefix + digits(String(seed), length - prefix.length - 1),
          );
          const code = String(number).padStart(4, "0");
          const value = spaced ? `${grouped(pan, 4)} ${code}` : pan + code;
          try {
            expect(await found("credit-card", `card_number=${value}`)).toEqual([
              value,
            ]);
          } finally {
            scanner?.close();
          }
        },
      ),
      { seed: 741530, numRuns: 50 },
    );
  });
  it("does not consume the next grouped card as a contextual security code", async () => {
    const first = "4271 5686 2827 7212";
    const second = "5156 3777 8930 3107";
    for (const code of ["", " 412", " 512", " 1234"]) {
      expect(
        await found("credit-card", `card=${first}${code} ${second}`),
      ).toEqual([`${first}${code}`, second]);
    }
  });
  it.each(["card", "card_number", "pan"])(
    "covers a PAN and its entire security code only with explicit %s context",
    async (key) => {
      const pan = "4271568628277212";
      for (const separator of [":", "="]) {
        for (const code of ["123", "1234"]) {
          for (const gap of ["", " "]) {
            const value = `${pan}${gap}${code}`;
            expect(
              await found("credit-card", `${key}${separator}${value}`),
            ).toEqual([value]);
          }
        }
      }
    },
  );
  it("keeps adjacent grouped candidates separate across configured lengths", async () => {
    const cards = [
      "4765 5296 0434 4",
      "5238 9571 9774 5007",
      "4257 2921 5251 1143 222",
      "6011 4821 3310 4216 442",
    ];
    expect(await found("credit-card", cards.join(" "))).toEqual(cards);
  });
  it("does not restart inside the numeric groups of a rejected long card", async () => {
    const text = "4000 4959 5707 2151 7";
    expect(await found("credit-card", text)).toEqual([]);
  });
  it("finds Visa, Mastercard, Amex and Discover numbers with Luhn-valid digits", async () => {
    const visa = luhnCard(`4${digits("visa", 14)}`);
    const master = luhnCard(`52${digits("master", 13)}`);
    const amex = luhnCard(`37${digits("amex", 12)}`);
    const discover = luhnCard(`6011${digits("discover", 11)}`);
    expect(
      await found(
        "credit-card",
        [
          visa,
          grouped(master, 4),
          `${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`,
          grouped(discover, 4).replaceAll(" ", "-"),
        ].join(" "),
      ),
    ).toEqual([
      visa,
      grouped(master, 4),
      `${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`,
      grouped(discover, 4).replaceAll(" ", "-"),
    ]);
  });

  it("keeps a card-shaped number that fails Luhn", async () => {
    expect(
      await found(
        "credit-card",
        lastDigitOff(luhnCard(`4${digits("bad", 14)}`)),
      ),
    ).toEqual([]);
  });

  it("keeps a digit run with no card prefix", async () => {
    expect(await found("credit-card", "order 1234567890123456")).toEqual([]);
  });
});

describe("French NIR", () => {
  it("finds a NIR with a valid key, spaced or not", async () => {
    const plain = nir(`2${"88"}06${"05"}801${"490"}`);
    const spaced = `2 88 06 05 801 490 ${plain.slice(-2)}`;
    expect(await found("fr-nir", `${plain} / ${spaced}`)).toEqual([
      plain,
      spaced,
    ]);
  });

  it("finds a Corsican NIR, where 2A counts as 19", async () => {
    const corsican = nir("185022A069300");
    expect(await found("fr-nir", corsican)).toEqual([corsican]);
  });

  it("keeps a NIR whose key fails", async () => {
    expect(await found("fr-nir", lastDigitOff(nir("1850226935667")))).toEqual(
      [],
    );
  });
});

describe("US SSN", () => {
  it("finds a dashed SSN", async () => {
    expect(await found("us-ssn", "ssn 512-48-7316")).toEqual(["512-48-7316"]);
  });

  it("keeps the SSN ranges that are never issued", async () => {
    expect(
      await found(
        "us-ssn",
        "000-12-3456 666-12-3456 912-34-5678 123-00-4567 123-45-0000",
      ),
    ).toEqual([]);
  });
});

describe("IPv4", () => {
  it("finds public addresses, including 172.32/16 outside the private range", async () => {
    expect(
      await found("ipv4", "from 8.8.8.8 and 172.32.0.1, then 203.0.113.7."),
    ).toEqual(["8.8.8.8", "172.32.0.1", "203.0.113.7"]);
  });

  it("keeps private, loopback, link-local, shared, multicast and unspecified addresses", async () => {
    expect(
      await found(
        "ipv4",
        "10.1.2.3 172.16.0.1 172.31.255.1 192.168.1.1 127.0.0.1 169.254.1.1 100.64.0.1 0.0.0.0 224.0.0.1 255.255.255.255",
      ),
    ).toEqual([]);
  });

  it("keeps version-like strings glued to a letter or a further dotted part", async () => {
    expect(await found("ipv4", "v8.8.8.8 and 8.8.8.8.1")).toEqual([]);
  });

  it("keeps section numbers and code step comments", async () => {
    expect(
      await found(
        "ipv4",
        "RFC 5891 §4.2.3.1, RFC 9700 section 4.4.2.2, // 7.6.3.1",
      ),
    ).toEqual([]);
  });
});

describe("IPv6", () => {
  it("finds full and compressed public addresses", async () => {
    const full = "2a62:cc12:8bae:a051:15ee:c482:2b07:e553";
    expect(
      await found("ipv6", `${full} 2001:db8::1 2a00:1450:4001:82a::200e`),
    ).toEqual([full, "2001:db8::1", "2a00:1450:4001:82a::200e"]);
  });

  it("keeps loopback, unspecified and link-local addresses and C++ scopes", async () => {
    expect(
      await found("ipv6", "::1 :: fe80::c0ff:ee std::vector foo::bar"),
    ).toEqual([]);
  });

  it("keeps unique local addresses, the IPv6 counterpart of private IPv4", async () => {
    expect(await found("ipv6", "fd00:ec2::254 fc00::1")).toEqual([]);
  });
});

describe("MAC address", () => {
  it("finds colon and dash separated addresses, not mixed ones", async () => {
    expect(
      await found(
        "mac",
        "96:ff:2c:15:65:90 and 00-94-CE-CD-28-5A and 96:ff-2c:15:65:90",
      ),
    ).toEqual(["96:ff:2c:15:65:90", "00-94-CE-CD-28-5A"]);
  });
});

describe("uuid", () => {
  it("finds a uuid in any case", async () => {
    const uuid = "2F5D6C1E-9a3b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(await found("uuid", `id ${uuid}`)).toEqual([uuid]);
  });

  // A clear glued copy that a later output teaches blocks each request of the session.
  it("finds a uuid glued with underscores in a file name", async () => {
    const uuid = "2f5d6c1e-9a3b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(
      await found("uuid", `2026-01-01T00-00-00Z_${uuid}_reviewer_0.md`),
    ).toEqual([uuid]);
  });

  it("skips a uuid shape inside a longer hex run", async () => {
    expect(
      await found("uuid", "a2f5d6c1e-9a3b-4c7d-8e9f-0a1b2c3d4e5f0"),
    ).toEqual([]);
  });
});

describe("validator names in config", () => {
  it("rejects a validator name that is not in the schema", () => {
    const { problems } = validateConfig(
      mergeConfigs([
        {
          rules: [
            { id: "x", type: "regex", pattern: "x", validate: "unknown" },
          ],
        },
      ]),
    );
    expect(problems).toEqual([
      "rules.x.validate must be equal to one of the allowed values.",
    ]);
  });

  it("accepts a known validator on a regex rule", () => {
    const rule: Partial<RegexRule> = { validate: "iban" };
    const { problems } = validateConfig(
      mergeConfigs([
        { rules: [{ id: "x", type: "regex", pattern: "x", ...rule }] },
      ]),
    );
    expect(problems).toEqual([]);
  });
});
