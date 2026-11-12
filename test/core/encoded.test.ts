import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodedViews, hiddenReadings } from "../../src/core/encoded.ts";
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

const base64 = (text: string) => Buffer.from(text).toString("base64");

function wrap(encoded: string, width: number): string {
  return Array.from(
    encoded.matchAll(new RegExp(`.{1,${width}}`, "g")),
    ([line]) => line,
  ).join("\n");
}

describe("decodedViews base64", () => {
  it("decodes a standard base64 run to its text", () => {
    const encoded = base64("user:hunter2-correct-horse");
    const views = decodedViews(`token=${encoded} end`);

    expect(views.map(({ start, end, text }) => [start, end, text])).toEqual([
      [6, 6 + encoded.length, "user:hunter2-correct-horse"],
    ]);
  });

  it("re-encodes a URL-safe run with its own alphabet", () => {
    const encoded = Buffer.from("secret???value???pass").toString("base64url");
    expect(encoded).toMatch(/[-_]/);
    const [view] = decodedViews(`key ${encoded}`);

    expect(view?.text).toBe("secret???value???pass");
    expect(view?.encode("secret???value???pass")).toBe(encoded);
  });

  it.each([64, 76])(
    "joins base64 wrapped at %i columns into one view",
    (width) => {
      const text = "db_password=hunter2 ".repeat(6);
      const wrapped = wrap(base64(text), width);
      const [view] = decodedViews(`head\n${wrapped}\ntail`);

      expect(view).toMatchObject({ start: 5, end: 5 + wrapped.length, text });
      expect(view?.encode(text)).toBe(wrapped);
    },
  );

  it("rejects base64 of gzip, PNG and protobuf bytes", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      seeded("png")(48),
    ]);
    const protobuf = Buffer.from([
      0x08, 0x96, 0x01, 0x12, 0x07, 0xff, 0xfe, 0x80, 0x81, 0x9a, 0xc3, 0x55,
    ]);
    for (const bytes of [gzipSync("user:password ".repeat(4)), png, protobuf]) {
      expect(decodedViews(`blob ${bytes.toString("base64")}`)).toEqual([]);
    }
  });

  it("ignores base64 inside data URIs", () => {
    expect(
      decodedViews(
        `src="data:text/plain;base64,${base64("user:password-value")}"`,
      ),
    ).toEqual([]);
  });

  it("decodes a Basic authorization credential to user:pass", () => {
    const [view] = decodedViews(
      `Authorization: Basic ${base64("user:pass-word-1")}`,
    );

    expect(view?.text).toBe("user:pass-word-1");
  });

  it("decodes one level only", () => {
    const inner = base64("user:password-value");
    const views = decodedViews(`x ${base64(inner)}`);

    expect(views.map((view) => view.text)).toEqual([inner]);
  });
});

describe("decodedViews percent-encoding", () => {
  it("decodes escapes and keeps the other characters literal", () => {
    const [view] = decodedViews("password=p%40ss%3Aword&x=1");

    expect(view).toMatchObject({ start: 9, end: 22, text: "p@ss:word" });
    expect(view?.encode("q@tt:wrod")).toBe("q%40tt%3Awrod");
  });

  it("keeps the hex case of each escape", () => {
    const [view] = decodedViews("path=a%2fb%2Fc");

    expect(view?.encode("a/b/c")).toBe("a%2fb%2Fc");
  });

  it("decodes a run escaped byte by byte, though every escape is unreserved", () => {
    const [view] = decodedViews("q=%53%45%43%2d%61");

    expect(view).toMatchObject({ start: 2, end: 17, text: "SEC-a" });
    expect(view?.encode("SEC-b")).toBe("%53%45%43%2d%62");
  });

  it("rejects escapes that decode to non-ASCII text", () => {
    expect(decodedViews("name=%C3%A9t%C3%A9")).toEqual([]);
  });

  it.each(["n%32", "year2%100", "bytesHashed%64"])(
    "ignores a percent sign in code, as in %s",
    (code) => {
      expect(decodedViews(`const x = ${code};`)).toEqual([]);
    },
  );
});

describe("decodedViews layout", () => {
  it("returns views sorted by start", () => {
    const encoded = base64("user:password-value");
    const views = decodedViews(`p%40ss%3Aword ${encoded}`);

    expect(views.map((view) => view.start)).toEqual([0, 14]);
  });

  it("prefers the base64 view where a base64 run and a percent run overlap", () => {
    const encoded = Buffer.from("secret???value???pass").toString("base64url");
    const views = decodedViews(`${encoded}%2Fx`);

    expect(views.map((view) => [view.start, view.end, view.text])).toEqual([
      [0, encoded.length, "secret???value???pass"],
    ]);
  });
});

describe("decodedViews false positives", () => {
  const sha1 = createHash("sha1").update("commit").digest("hex");
  const sha256 = createHash("sha256").update("module").digest("hex");
  const integrity = `sha512-${createHash("sha512").update("pkg").digest("base64")}`;
  const samples: Record<string, string> = {
    "git SHA": `commit ${sha1}`,
    "hex digest": `digest ${sha256}`,
    UUID: "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "npm integrity": `"integrity": "${integrity}"`,
    "sourcemap mappings":
      '"mappings":"AAAA,SAASA,MAAMA;AACA,IAAIC,OAAOC,EAAE;AAAA,EAAE,MAAM"',
    "base64-shaped words":
      "internationalization getElementsByClassName MyVeryLongClassNameHere",
  };

  it.each(Object.entries(samples))("returns no view for %s", (_, text) => {
    expect(decodedViews(text)).toEqual([]);
  });
});

describe("decodedViews same-length replacements", () => {
  it("keeps the encoded length for any same-length ASCII text", () => {
    const text = [
      `token=${base64("user:hunter2-correct-horse")}`,
      `wrapped\n${wrap(base64("db_password=hunter2 ".repeat(6)), 64)}`,
      "password=p%40ss%3Aword",
    ].join("\n");
    const views = decodedViews(text);

    expect(views).toHaveLength(3);
    for (const [index, view] of views.entries()) {
      const fake = reshape(view.text, seeded(`view-${index}`));
      expect(view.encode(fake)).toHaveLength(view.end - view.start);
    }
  });
});

describe("hiddenReadings run time", () => {
  it.each([
    ["a hex run without a character column", `a1b2c3d: ${"0".repeat(56)}`],
    ["blank lines", "\n".repeat(30_000)],
  ])("reads %s in linear time", (_, text) => {
    const start = performance.now();
    hiddenReadings(text, (value) => value);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("hiddenReadings", () => {
  it("keeps a numeric entity past the last code point instead of throwing", () => {
    expect(() =>
      hiddenReadings("&#9999999;&#xFFFFFF;", (value) => value),
    ).not.toThrow();
  });

  it("decodes each escape and entity once, with any leading zeros", () => {
    expect(
      hiddenReadings(
        String.raw`\u005c/ \\u0041 &#38;lt; &#00000047;&#x000002F;`,
        (value) => value,
      ),
    ).toContain(String.raw`\/ \u0041 &lt; //`);
  });
});
