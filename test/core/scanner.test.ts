import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  keyedPattern,
  literalPattern,
  Scanner,
  ScanError,
} from "../../src/core/scanner.ts";

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.close();
  vi.restoreAllMocks();
});

function texts(text: string, spans: [number, number, number][]): string[] {
  return spans.map(([start, end]) => text.slice(start, end));
}

describe("Scanner", () => {
  it("scans the largest payload with a match in every line", async () => {
    scanner = new Scanner(30_000);
    const line = "user=TE1234567 two-byte é\n";
    const text = line.repeat(Math.floor((8 * 1024 * 1024) / line.length));
    const [spans] = await scanner.scan(
      [{ source: "TE\\d{7}", flags: "", group: 0 }],
      [text],
    );
    expect(spans).toHaveLength(text.length / line.length);
  }, 60_000);
  it("unions only validated overlaps with a contextual card when its prefix is not a PAN", async () => {
    scanner = new Scanner(1000);
    const text = "card=5156377789304006 0000000000003";
    const [spans] = await scanner.scan(
      [
        {
          source: "(?:card=(\\d{16} \\d{4})|(\\d{4} \\d{13}))",
          flags: "",
          group: "auto",
          validate: "luhn",
        },
      ],
      [text],
    );
    expect(spans).toEqual([[5, text.length, 0]]);
  });
  it.each(["bad ", "😀 "])(
    "restarts after a rejected candidate start without splitting Unicode: %s",
    async (prefix) => {
      scanner = new Scanner(1000);
      const text = `${prefix}8.8.8.8`;
      const [spans] = await scanner.scan(
        [
          {
            source: `(?:${prefix})?8\\.8\\.8\\.8`,
            flags: "u",
            group: 0,
            validate: "public-ipv4",
          },
        ],
        [text],
      );
      expect(spans).toEqual([[prefix.length, text.length, 0]]);
    },
  );
  it("returns the spans of every pattern, or of the chosen group", async () => {
    scanner = new Scanner(1000);
    const text = "a ORD-123456 and ORD-98765, x";
    const [spans] = await scanner.scan(
      [
        { source: "\\b[A-Z]{2,10}-(\\d{5,})\\b", flags: "", group: 1 },
        { source: "x", flags: "", group: 0 },
      ],
      [text],
    );
    expect(spans && texts(text, spans)).toEqual(["123456", "98765", "x"]);
    expect(spans?.map((span) => span[2])).toEqual([0, 0, 1]);
  });

  it("matches keyed values in JSON, YAML, env and query forms", async () => {
    scanner = new Scanner(1000);
    const pattern = keyedPattern(
      ["clientId", "apiKey"],
      "[A-Za-z0-9_-]*\\d[A-Za-z0-9_-]*",
    );
    const samples = [
      ['{"clientId": "abc123"}', "abc123"],
      ["clientId: 42abc", "42abc"],
      ["CLIENT_ID=9z", "9z"],
      ["?client_id=777&x=1", "777"],
      ["X_API_KEY='k3y'", "k3y"],
      ["parentClientId: 'p1'", "p1"],
      ["clientIds: c1", undefined],
      ["clientId: noDigits", undefined],
      ["clientId: user1.name", undefined],
    ] as const;
    const result = await scanner.scan(
      [pattern],
      samples.map(([text]) => text),
    );
    samples.forEach(([text, expected], index) => {
      const spans = result[index] ?? [];
      expect(texts(text, spans)[0]).toBe(expected);
    });
  });

  it("matches a keyed value with a Unicode letter class", async () => {
    scanner = new Scanner(1000);
    const text = "label: é";
    const [spans] = await scanner.scan(
      [keyedPattern(["label"], "\\p{L}+")],
      [text],
    );
    expect(spans && texts(text, spans)).toEqual(["é"]);
  });

  it("steps over a whole emoji after an empty match and finds the next value", async () => {
    scanner = new Scanner(1000);
    const [spans] = await scanner.scan(
      [{ source: "x?", flags: "u", group: 0 }],
      ["😀x"],
    );
    expect(spans).toEqual([[2, 3, 0]]);
  });

  it("does not fail a replacement scan on an error from a terminated worker", async () => {
    scanner = new Scanner(1000);
    const good = { source: "x", flags: "", group: 0 };
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    await scanner.scan([good], ["x"]);
    const first = post.mock.contexts[0];
    if (!(first instanceof Worker)) throw new Error("no first worker");
    first.emit("exit", 1);
    expect(terminate.mock.contexts).toEqual([first]);
    const replacement = scanner.scan([good], ["x"]);
    first.emit("error", new Error("late worker error"));
    await expect(replacement).resolves.toEqual([[[0, 1, 0]]]);
    expect(post.mock.contexts[1]).not.toBe(first);
  });

  it("rejects a scan after close without starting a worker", async () => {
    scanner = new Scanner(1000);
    const good = { source: "x", flags: "", group: 0 };
    const post = vi.spyOn(Worker.prototype, "postMessage");
    await scanner.scan([good], ["x"]);
    scanner.close();

    await expect(scanner.scan([good], ["x"])).rejects.toMatchObject({
      code: "SCAN_CRASH",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("matches literals only on token boundaries, longest first", async () => {
    scanner = new Scanner(1000);
    const pattern = literalPattern(["jane", "/Users/jane", "Secret"], true);
    const text = "/Users/jane/x jane janeboss xjane SECRET";
    const [spans] = await scanner.scan([pattern], [text]);
    expect(spans && texts(text, spans)).toEqual([
      "/Users/jane",
      "jane",
      "SECRET",
    ]);
  });

  it("fails closed with a timeout on catastrophic backtracking and recovers", async () => {
    scanner = new Scanner(200);
    const evil = { source: "^(a+)+$", flags: "", group: 0 };
    await expect(
      scanner.scan([evil], ["a".repeat(40) + "b"]),
    ).rejects.toMatchObject({
      code: "SCAN_TIMEOUT",
    });
    const [spans] = await scanner.scan(
      [{ source: "b", flags: "", group: 0 }],
      ["ab"],
    );
    expect(spans).toEqual([[1, 2, 0]]);
  });

  it("applies gitleaks semantics: auto group, keywords, entropy, allowlists", async () => {
    scanner = new Scanner(1000);
    const text =
      "KEY=Zx9Qw2Lm7Rt5\nKEY=aaaaaaaaaaaa\nKEY=EXAMPLEb7Qz9\n# fixture\nKEY=Fz8Kp3Nq6Vb1\nkey: Hj4Ty7Ui0Op2";
    const base = {
      source: "KEY=(\\w+)|key: (\\w+)",
      flags: "",
      group: "auto" as const,
    };
    const [spans] = await scanner.scan(
      [
        {
          ...base,
          keywords: ["key"],
          entropy: 3,
          allow: [
            {
              target: "secret" as const,
              regexes: ["^EXAMPLE"],
              stopwords: [],
              all: false,
            },
            {
              target: "line" as const,
              regexes: ["fixture"],
              stopwords: ["fz8"],
              all: true,
            },
          ],
        },
        { ...base, keywords: ["absent"] },
      ],
      [text],
    );
    expect(spans && texts(text, spans)).toEqual([
      "Zx9Qw2Lm7Rt5",
      "Fz8Kp3Nq6Vb1",
      "Hj4Ty7Ui0Op2",
    ]);
  });

  it("runs a rule whose keyword occurs only as the start of a longer keyword", async () => {
    scanner = new Scanner(1000);
    const [spans] = await scanner.scan(
      [
        { source: "password", flags: "", group: 0, keywords: ["password"] },
        { source: "pass", flags: "", group: 0, keywords: ["pass"] },
      ],
      ["password"],
    );
    expect(spans).toEqual([
      [0, 8, 0],
      [0, 4, 1],
    ]);
  });

  it("runs each scan with the keywords of its own patterns", async () => {
    scanner = new Scanner(1000);
    const rule = (word: string) => ({
      source: word,
      flags: "",
      group: 0,
      keywords: [word],
    });
    await scanner.scan([rule("alpha")], ["alpha"]);
    expect(await scanner.scan([rule("beta")], ["beta"])).toEqual([[[0, 4, 0]]]);
  });

  it("runs a pattern with an empty keyword after a scan without keywords", async () => {
    scanner = new Scanner(1000);
    await scanner.scan([{ source: "x", flags: "", group: 0 }], ["x"]);
    expect(
      await scanner.scan(
        [{ source: "tok", flags: "", group: 0, keywords: [""] }],
        ["tok"],
      ),
    ).toEqual([[[0, 3, 0]]]);
  });

  it("drops an allowlisted value when every check of an all-list passes", async () => {
    scanner = new Scanner(1000);
    const text = "fixture KEY=Fz8Kp3Nq6Vb1";
    const [spans] = await scanner.scan(
      [
        {
          source: "KEY=(\\w+)",
          flags: "",
          group: 1,
          allow: [
            {
              target: "line",
              regexes: ["fixture"],
              stopwords: ["fz8"],
              all: true,
            },
          ],
        },
      ],
      [text],
    );
    expect(spans).toEqual([]);
  });

  it("reports an invalid pattern without its text", async () => {
    scanner = new Scanner(1000);
    const error = await scanner
      .scan([{ source: "(", flags: "", group: 0 }], ["x"])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScanError);
    expect(error).toMatchObject({
      code: "SCAN_PATTERN",
      message: "SCAN_PATTERN: pattern 0",
    });
  });
});
