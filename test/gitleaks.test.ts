import { describe, expect, it } from "vitest";
import {
  convertGoRegex,
  importGitleaks,
  renderGitleaks,
} from "../scripts/import-gitleaks.ts";
import { GITLEAKS_RULES } from "../src/core/gitleaks-rules.ts";

function compile(go: string): RegExp {
  return new RegExp(convertGoRegex(go));
}

describe("convertGoRegex", () => {
  it("turns a leading (?i) into caseless letters", () => {
    const regex = compile("(?i)abc");
    expect(regex.test("aBC")).toBe(true);
  });

  it("scopes a middle (?i) to the rest of its group", () => {
    const regex = compile("^(p8e-(?i)[a-z0-9]{3})x$");
    expect(regex.test("p8e-AB1x")).toBe(true);
    expect(regex.test("P8E-ab1x")).toBe(false);
    expect(regex.test("p8e-ab1X")).toBe(false);
  });

  it("keeps (?-i:...) case sensitive inside a caseless scope", () => {
    const regex = compile("^(?i)x(?-i:acc)y$");
    expect(regex.test("XaccY")).toBe(true);
    expect(regex.test("XACCY")).toBe(false);
  });

  it("expands ranges and POSIX classes, and leaves escapes and quantifiers alone", () => {
    const regex = compile("^(?i)[[:alnum:]_]{2}\\x60\\d{1,2}\\.[b-d]$");
    expect(regex.test("aZ`12.C")).toBe(true);
    expect(regex.test(":Z`12.C")).toBe(false);
    expect(() => convertGoRegex("[[:space:]]")).toThrow(
      "unsupported class [:space:]",
    );
  });

  it("keeps a leading ] inside a class literal", () => {
    const regex = compile("^[^]]+]$");
    expect(regex.test("ab]")).toBe(true);
    expect(regex.test("a]]")).toBe(false);
  });

  it("maps \\z to the end of input and (?P<name> to (?<name>", () => {
    expect(compile("a\\z").test("ba")).toBe(true);
    expect(compile("a\\z").test("az")).toBe(false);
    expect(compile("(?P<x>q)").exec("q")?.groups?.x).toBe("q");
  });

  it("scopes (?s:...) so the dot also matches newlines there only", () => {
    const regex = compile("^(?s:a.b).$");
    expect(regex.test("a\nbc")).toBe(true);
    expect(regex.test("a\nb\n")).toBe(false);
  });

  it("rejects flags it cannot translate", () => {
    expect(() => convertGoRegex("(?m)^a")).toThrow(
      "unsupported flag group (?m)",
    );
  });
});

describe("importGitleaks", () => {
  it("anchors each branch of an allowlist alternation that starts with ^ and ends with $", () => {
    const { global } = importGitleaks({
      rules: [],
      allowlist: { regexes: ["(?i)^true|false|null$", "^a|b(c|d)$"] },
    });
    const [boolean, nested] = (global?.regexes ?? []).map(
      (source) => new RegExp(source),
    );
    expect(boolean?.test("FALSE")).toBe(true);
    expect(boolean?.test("Xq9falseR7tLm2vB8")).toBe(false);
    expect(boolean?.test("trueXq9R7tLm2vB8")).toBe(false);
    expect(nested?.test("bd")).toBe(true);
    expect(nested?.test("xbd")).toBe(false);
  });

  it("keeps a value that holds a word of the global allowlist in the shipped rules", () => {
    const [shared] = GITLEAKS_RULES[0]?.allow ?? [];
    const regexes = (shared?.regexes ?? []).map((source) => new RegExp(source));
    expect(regexes.some((regex) => regex.test("null"))).toBe(true);
    expect(regexes.some((regex) => regex.test("Xq9falseR7tLm2vB8"))).toBe(
      false,
    );
  });

  it("maps rule fields and global allowlists, and lists skipped rules", () => {
    const { rules, global, skipped } = importGitleaks({
      allowlist: {
        regexes: ["^EXAMPLE$"],
        stopwords: ["sample"],
        paths: ["x"],
      },
      rules: [
        {
          id: "demo-token",
          regex: "(?i)\\b(demo_[a-z]{4})\\b",
          secretGroup: 1,
          entropy: 2.5,
          keywords: ["Demo_"],
          allowlists: [
            {
              regexTarget: "line",
              regexes: ["fixture"],
              condition: "AND",
              stopwords: ["zz"],
            },
          ],
        },
        { id: "auto-group", regex: "k=(\\w+)" },
        { id: "path-only", path: "\\.p12$" },
        { id: "path-scoped", regex: "a", path: "\\.tf$" },
        { id: "go-only", regex: "(?m)^a" },
      ],
    });
    expect(rules).toEqual([
      {
        id: "gitleaks.demo-token",
        type: "regex",
        enabled: true,
        strategy: "opaque",
        pattern: convertGoRegex("(?i)\\b(demo_[a-z]{4})\\b"),
        flags: "",
        group: 1,
        keywords: ["demo_"],
        entropy: 2.5,
        allow: [
          {
            target: "line",
            regexes: ["fixture"],
            stopwords: ["zz"],
            all: true,
          },
        ],
      },
      {
        id: "gitleaks.auto-group",
        type: "regex",
        enabled: true,
        strategy: "opaque",
        pattern: "k=(\\w+)",
        flags: "",
        group: "auto",
        keywords: [],
      },
    ]);
    expect(global).toEqual({
      target: "secret",
      regexes: ["^EXAMPLE$"],
      stopwords: ["sample"],
      all: false,
    });
    expect(skipped).toEqual([
      { id: "path-only", reason: "path-scoped rule" },
      { id: "path-scoped", reason: "path-scoped rule" },
      { id: "go-only", reason: "unsupported flag group (?m)" },
    ]);
  });

  it("refuses a rule id that is not a plain name", () => {
    expect(() =>
      importGitleaks({ rules: [{ id: "a\nglobalThis.x=1//", regex: "a" }] }),
    ).toThrow(/rule id/);
  });
});

describe("renderGitleaks", () => {
  const codeLines = (text: string) =>
    text
      .split(/\r\n?|[\n\u2028\u2029]/)
      .filter((line) => !line.startsWith("//"));

  it.each(["\n", "\r", "\u2028", "\u2029"])(
    "keeps a skipped rule's reason with %j inside its comment",
    (newline) => {
      const imported = importGitleaks({
        rules: [{ id: "bad", regex: `(?x${newline}globalThis.x=1//)a` }],
      });
      expect(imported.skipped[0]?.reason).toContain(newline);
      expect(
        codeLines(renderGitleaks(imported, "8.30.1")).join("\n"),
      ).not.toContain("globalThis");
    },
  );

  it("refuses a version that is not a plain version number", () => {
    expect(() =>
      renderGitleaks(importGitleaks({ rules: [] }), "1\nglobalThis.x=1//"),
    ).toThrow(/version/);
  });
});
