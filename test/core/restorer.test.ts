import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../../src/core/config.ts";
import { keyedBytes } from "../../src/core/keyed-bytes.ts";
import { Masker } from "../../src/core/masker.ts";
import { TextRestorer } from "../../src/core/restorer.ts";
import { Scanner } from "../../src/core/scanner.ts";
import { Vault } from "../../src/core/vault.ts";

const scanner = new Scanner(5000);
afterAll(() => scanner.close());

/** A configured value shorter than a learned real. */
const PIN = "Kx7pQ";
/** Configured values of letters only or digits only: masking finds no copy glued to a word. */
const WORDS = ["Bluebird", "48151623"];

function build(): { masker: Masker; vault: Vault } {
  const vault = new Vault(keyedBytes(new Uint8Array(32).fill(7)));
  const masker = new Masker(
    [
      ...DEFAULT_RULES,
      {
        id: "pin",
        type: "literal",
        enabled: true,
        strategy: "opaque",
        values: [PIN, ...WORDS],
      },
    ],
    scanner,
    vault,
    {},
    { opaque: () => false },
  );
  return { masker, vault };
}

/** Restores `text` in pieces whose lengths cycle through `sizes`. */
function shown(masker: Masker, text: string, sizes: number[] = []): string {
  const restorer = new TextRestorer(masker);
  let out = "";
  let at = 0;
  for (let index = 0; sizes.length > 0 && at < text.length; index++) {
    const size = sizes[index % sizes.length];
    out += restorer.push(text.slice(at, at + size));
    at += size;
  }
  return out + restorer.push(text.slice(at)) + restorer.end();
}

/** A reply that writes the fakes of `values`, alone and with their context, between `around`. */
async function reply(
  masker: Masker,
  vault: Vault,
  values: string[],
  around: string[],
): Promise<string> {
  const [masked] = await masker.mask([values.join(" ")]);
  const words = [
    ...masked.split(" "),
    ...vault.fakeSpans(masked).map(([start, end]) => masked.slice(start, end)),
  ];
  return around
    .map((part, index) => `${part}${words[index % words.length]}`)
    .join("");
}

const alnum = (length: number) =>
  fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${length}}$`));

/** Texts with secrets of the kinds that a model writes back: tokens, keyed values, emails and configured values. */
const secrets = fc.array(
  fc.oneof(
    fc.constant(PIN),
    fc.constantFrom(...WORDS),
    alnum(36).map((tail) => `ghp_${tail}`),
    alnum(10).map((value) => `password=${value}`),
    alnum(5).map((value) => `pwd=${value}`),
    fc.tuple(alnum(6), alnum(5)).map(([user, host]) => `${user}@${host}.com`),
  ),
  { minLength: 1, maxLength: 4 },
);

/** What a model writes around fakes: words, punctuation, markdown and JSON escapes. */
const around = fc.array(
  fc.constantFrom(
    " ",
    "\n",
    "_",
    "`",
    '"',
    "\\",
    "/",
    ".",
    "-",
    "é",
    "x",
    "9",
    "**",
    "=",
    ":",
  ),
  { minLength: 1, maxLength: 12 },
);

describe("TextRestorer", () => {
  it("gives the same text however the stream is cut", async () => {
    await fc.assert(
      fc.asyncProperty(
        secrets,
        around,
        fc.array(fc.integer({ min: 1, max: 9 }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (values, parts, sizes) => {
          const { masker, vault } = build();
          const text = await reply(masker, vault, values, parts);
          expect(shown(masker, text, sizes)).toBe(shown(masker, text));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("restores only reals that masking hides again", async () => {
    await fc.assert(
      fc.asyncProperty(secrets, around, async (values, parts) => {
        const { masker, vault } = build();
        const text = await reply(masker, vault, values, parts);
        // A refused mask sends nothing.
        const again = await masker.mask([shown(masker, text)]).then(
          ([masked]) => masked,
          () => undefined,
        );
        fc.pre(again !== undefined);
        for (const [real] of vault.entries()) expect(again).not.toContain(real);
      }),
      { numRuns: 60 },
    );
  });

  it.each([
    ["a token", "ghp_Zq8Lm2Xv9Rt4Wk7Np3Hs6Jd1Fg5Bc0Ya8UeQ"],
    ["a configured value shorter than a learned real", PIN],
  ])("puts back %s that the model writes alone", async (_, real) => {
    const { masker } = build();
    const [fake] = await masker.mask([real]);
    expect(fake).not.toBe(real);
    expect(shown(masker, `use ${fake} now`, [5, 4])).toBe(`use ${real} now`);
  });

  it("keeps the fake of a short value that masking finds only by its key", async () => {
    const { masker } = build();
    const [masked] = await masker.mask(["pwd=ab12c"]);
    const fake = masked.slice(4);
    expect(shown(masker, `the password is ${fake}`)).toBe(
      `the password is ${fake}`,
    );
  });
});
