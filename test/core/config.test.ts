import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  DEFAULT_RULES,
  DEFAULT_SETTINGS,
  type HostDefaults,
  loadConfig,
  mergeConfigs,
  protectedPatterns,
  validateConfig,
} from "../../src/core/config.ts";

const HOST: HostDefaults = {
  rules: [],
  protectedPaths: ["**/host-vaults/**"],
  tools: ["read", "bash"],
};

describe("validateConfig", () => {
  it("accepts an empty object and returns the defaults", () => {
    const { config, problems } = validateConfig(mergeConfigs([{}]));
    expect(problems).toEqual([]);
    expect(config.rules.map((rule) => rule.id)).toEqual(
      DEFAULT_RULES.map((rule) => rule.id),
    );
    expect(config.protectedPaths).toContain("**/.env*");
  });

  it("reports unknown keys, wrong types and invalid rules", () => {
    const { problems } = validateConfig(
      mergeConfigs([
        {
          unknown: 1,
          rules: [
            { id: "a", type: "regex", pattern: "(" },
            { id: "b", type: "regex", pattern: "x", flags: "gy" },
            { id: "c", type: "literal", values: [] },
            { id: "e", type: "fixed-typo" },
            { id: "f", type: "literal", values: ["x"], strategy: "fixed" },
            { id: "g", type: "regex", pattern: "a(b)", group: 2 },
            { id: "h", type: "literal", values: ["v"], extra: true },
            {
              id: "j",
              type: "regex",
              pattern: "x",
              allow: [
                { target: "line", regexes: ["("], stopwords: [], all: false },
              ],
            },
          ],
        },
      ]),
    );
    expect(problems).toEqual([
      "unknown is not a known setting.",
      "rules.a.pattern is not a valid regular expression.",
      'rules.b.flags must match pattern "^[imsu]*$".',
      "rules.c.values must not have fewer than 1 items.",
      "rules.e.type must be one of literal, env, regex, keyed.",
      "rules.f.replacement is required for the fixed strategy.",
      "rules.g.group must be a capture group of the pattern.",
      "rules.h.extra is not a known setting.",
      "rules.j.allow has an invalid regular expression.",
    ]);
  });

  it("rejects a rule without an id", () => {
    expect(
      validateConfig(mergeConfigs([{ rules: [{ type: "literal" }] }])).problems,
    ).toEqual([
      "rules: every rule needs an id that matches ^[A-Za-z0-9][A-Za-z0-9._-]*$.",
    ]);
  });

  it("reports an env rule with neither vars nor namePattern, and an invalid namePattern", () => {
    const { problems } = validateConfig(
      mergeConfigs([
        {
          rules: [
            { id: "none", type: "env" },
            { id: "bad", type: "env", namePattern: "(" },
          ],
        },
      ]),
    );
    expect(problems).toEqual([
      "rules.none needs vars or namePattern.",
      "rules.bad.namePattern is not a valid regular expression.",
    ]);
  });

  it("matches the published JSON Schema", () => {
    const published: unknown = JSON.parse(
      readFileSync(
        new URL("../../schema/config.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(published).toEqual(JSON.parse(JSON.stringify(ConfigSchema)));
  });
});

describe("mergeConfigs", () => {
  it("turns off the default env name rule by id", () => {
    const { config, problems } = validateConfig(
      mergeConfigs([{ rules: [{ id: "env-secret-names", enabled: false }] }]),
    );
    expect(problems).toEqual([]);
    expect(
      config.rules.find((rule) => rule.id === "env-secret-names")?.enabled,
    ).toBe(false);
  });

  it("defaults a rule strategy to opaque, not shape", () => {
    const { config, problems } = validateConfig(
      mergeConfigs([
        { rules: [{ id: "ids", type: "literal", values: ["ABC-1"] }] },
      ]),
    );
    expect(problems).toEqual([]);
    expect(config.rules.find((rule) => rule.id === "ids")?.strategy).toBe(
      "opaque",
    );
  });

  it("merges rules by id, later levels win, and appends new rules", () => {
    const merged = mergeConfigs([
      { rules: [{ id: "email", enabled: false }] },
      {
        rules: [
          { id: "email", strategy: "mask" },
          { id: "ids", type: "literal", values: ["ABC-1"] },
        ],
      },
    ]);
    const { config, problems } = validateConfig(merged);
    expect(problems).toEqual([]);
    const email = config.rules.find((rule) => rule.id === "email");
    expect(email?.enabled).toBe(false);
    expect(email?.strategy).toBe("mask");
    expect(config.rules.at(-1)?.id).toBe("ids");
  });

  it("adds protected paths and removes them with a ! prefix", () => {
    const { config } = validateConfig(
      mergeConfigs([
        { protectedPaths: ["**/vault/**"] },
        { protectedPaths: ["!**/.env*"] },
      ]),
    );
    expect(config.protectedPaths).toContain("**/vault/**");
    expect(config.protectedPaths).not.toContain("**/.env*");
  });

  it("adds network commands and restored tools and removes them with a ! prefix", () => {
    const { config, problems } = validateConfig(
      mergeConfigs([
        { restoredTools: HOST.tools },
        { networkCommands: ["http", "!ftp"], restoredTools: ["!bash"] },
      ]),
      HOST.tools,
    );
    expect(problems).toEqual([]);
    expect(config.networkCommands).toContain("http");
    expect(config.networkCommands).not.toContain("ftp");
    expect(config.restoredTools).not.toContain("bash");
  });

  it("reports a restored tool that the host does not restore", () => {
    const { problems } = validateConfig(
      mergeConfigs([{ restoredTools: ["codemode"] }]),
      HOST.tools,
    );
    expect(problems).toEqual([
      "restoredTools: codemode is not a tool that the host restores.",
    ]);
  });

  it("reports a null list setting", () => {
    const { problems } = validateConfig(
      mergeConfigs([
        { protectedPaths: null, networkCommands: null, restoredTools: null },
      ]),
    );
    expect(problems).toEqual([
      "protectedPaths.22 must be string.",
      `networkCommands.${DEFAULT_SETTINGS.networkCommands.length} must be string.`,
      "restoredTools.0 must be string.",
    ]);
  });

  it("reports a scan timeout that setTimeout cannot hold", () => {
    const { problems } = validateConfig(
      mergeConfigs([{ scanTimeoutMs: 2 ** 31 }]),
    );
    expect(problems).toEqual(["scanTimeoutMs must be <= 2147483647."]);
  });

  // A leading space would let each space of a long command start a new `\s+` scan.
  it.each([" x", "x ", " "])(
    "reports the network command %j that starts or ends with a space",
    (name) => {
      const { problems } = validateConfig(
        mergeConfigs([{ networkCommands: [name] }]),
      );
      expect(problems).toEqual([
        expect.stringMatching(
          `^networkCommands\\.${DEFAULT_SETTINGS.networkCommands.length} must match pattern`,
        ),
      ]);
    },
  );
});

describe("loadConfig", () => {
  it("reads absent files as empty and reports invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    const ok = join(dir, "ok.json");
    writeFileSync(
      ok,
      JSON.stringify({ rules: [{ id: "email", enabled: false }] }),
    );
    const result = loadConfig([join(dir, "missing.json"), ok], undefined, HOST);
    expect(result.problems).toEqual([]);
    expect(
      result.config.rules.find((rule) => rule.id === "email")?.enabled,
    ).toBe(false);
    expect(result.sources).toEqual([ok]);
    expect(loadConfig([bad], undefined, HOST).problems).toEqual([
      `${bad}: invalid JSON.`,
    ]);
  });

  it("reports a file that is not valid UTF-8 instead of replacing its bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const path = join(dir, "invalid-utf8.json");
    // 0xFF never occurs in UTF-8; a lossy decode would turn it into U+FFFD and change the value.
    writeFileSync(
      path,
      Buffer.from(
        '{"rules":[{"id":"ord-ids","type":"literal","values":["ORD-123456\xff"]}]}',
        "latin1",
      ),
    );
    expect(loadConfig([path], undefined, HOST).problems).toEqual([
      `${path}: invalid UTF-8.`,
    ]);
  });

  it("reads valid multi-byte UTF-8 unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const path = join(dir, "multi-byte.json");
    writeFileSync(
      path,
      JSON.stringify({
        rules: [{ id: "ord-ids", type: "literal", values: ["ORD-123456é"] }],
      }),
    );
    const result = loadConfig([path], undefined, HOST);
    expect(result.problems).toEqual([]);
    expect(
      result.config.rules.find((rule) => rule.id === "ord-ids"),
    ).toMatchObject({
      values: ["ORD-123456é"],
    });
  });

  it("keeps a byte order mark an invalid JSON error", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const path = join(dir, "bom.json");
    writeFileSync(path, "\uFEFF{}");
    expect(loadConfig([path], undefined, HOST).problems).toEqual([
      `${path}: invalid JSON.`,
    ]);
  });

  it("reports a dangling symlink as unreadable instead of missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const link = join(dir, "dangling-link.json");
    symlinkSync(join(dir, "target-missing.json"), link);
    expect(loadConfig([link], undefined, HOST).problems).toEqual([
      `${link}: cannot be read.`,
    ]);
  });

  it("reads a symlink whose target exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const target = join(dir, "target.json");
    writeFileSync(target, JSON.stringify({ protectedPaths: ["**/vault/**"] }));
    const link = join(dir, "linked.json");
    symlinkSync(target, link);
    const result = loadConfig([link], undefined, HOST);
    expect(result.problems).toEqual([]);
    expect(result.sources).toEqual([link]);
    expect(result.config.protectedPaths).toContain("**/vault/**");
  });
});

describe("loadConfig with a project level", () => {
  function levelFile(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "mask-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it("keeps the global level authoritative: it may disable a default rule and remove a default path", () => {
    const global = levelFile({
      rules: [{ id: "email", enabled: false }],
      protectedPaths: ["!**/.env*"],
    });
    const result = loadConfig([global], undefined, HOST);
    expect(result.problems).toEqual([]);
    expect(
      result.config.rules.find((rule) => rule.id === "email")?.enabled,
    ).toBe(false);
    expect(result.config.protectedPaths).not.toContain("**/.env*");
  });

  it("reports a project rule that disables an inherited default rule", () => {
    const project = levelFile({ rules: [{ id: "email", enabled: false }] });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "rules.email is inherited: project config cannot change it.",
    ]);
  });

  it("reports a lone project rule object that disables an inherited default rule", () => {
    const project = levelFile({ rules: { id: "email", enabled: false } });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "rules.email is inherited: project config cannot change it.",
    ]);
  });

  it("reports a project rule that changes a rule added by the global level", () => {
    const global = levelFile({
      rules: [{ id: "ids", type: "literal", values: ["ABC-1"] }],
    });
    const project = levelFile({ rules: [{ id: "ids", strategy: "mask" }] });
    expect(loadConfig([global], project, HOST).problems).toEqual([
      "rules.ids is inherited: project config cannot change it.",
    ]);
  });

  it("reports a project protectedPaths entry that removes a default path", () => {
    const project = levelFile({ protectedPaths: ["!**/.env*"] });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "protectedPaths: project config cannot remove **/.env*.",
    ]);
  });

  it("reports project settings that only the global level may change", () => {
    const project = levelFile({
      networkCommands: ["http", "!curl"],
      restoredTools: ["mcp__notes__search"],
      withholdHiddenCopies: false,
      scanTimeoutMs: 60000,
    });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "networkCommands: project config cannot remove curl.",
      "restoredTools: only the global config can change it.",
      "withholdHiddenCopies: only the global config can change it.",
      "scanTimeoutMs: only the global config can change it.",
      "restoredTools: mcp__notes__search is not a tool that the host restores.",
    ]);
  });

  it("reports a lone project protectedPaths string that removes a default path", () => {
    const project = levelFile({ protectedPaths: "!**/.env*" });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "protectedPaths: project config cannot remove **/.env*.",
    ]);
  });

  it("adds the host paths and tools to the defaults", () => {
    const { config, problems } = loadConfig([], undefined, HOST);
    expect(problems).toEqual([]);
    expect(config.protectedPaths).toContain("**/.env*");
    expect(config.protectedPaths).toContain("**/host-vaults/**");
    expect(config.restoredTools).toEqual(HOST.tools);
  });

  it("reports a project protectedPaths entry that removes a host path", () => {
    const project = levelFile({ protectedPaths: ["!**/host-vaults/**"] });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "protectedPaths: project config cannot remove **/host-vaults/**.",
    ]);
  });

  it("reports a project protectedPaths entry that removes a path added by the global level", () => {
    const global = levelFile({ protectedPaths: ["**/vault/**"] });
    const project = levelFile({ protectedPaths: ["!**/vault/**"] });
    expect(loadConfig([global], project, HOST).problems).toEqual([
      "protectedPaths: project config cannot remove **/vault/**.",
    ]);
  });

  it("accepts a project level that adds a new rule and new protected paths", () => {
    const project = levelFile({
      rules: [{ id: "project-ids", type: "literal", values: ["ORD-1"] }],
      protectedPaths: ["**/vault/**"],
    });
    const result = loadConfig([], project, HOST);
    expect(result.problems).toEqual([]);
    expect(result.config.rules.at(-1)?.id).toBe("project-ids");
    expect(result.config.protectedPaths).toContain("**/vault/**");
  });

  it("reports an invalid rule that the project level adds", () => {
    const project = levelFile({
      rules: [{ id: "project-bad", type: "regex", pattern: "(" }],
    });
    expect(loadConfig([], project, HOST).problems).toEqual([
      "rules.project-bad.pattern is not a valid regular expression.",
    ]);
  });
});

describe("protectedPatterns", () => {
  const write = (config: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), "lmsk-pp-")), "config.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  };

  it("gives the configured patterns, with the host paths, an added pattern and without a removed one", () => {
    const patterns = protectedPatterns(
      [write({ protectedPaths: ["**/notes.txt", "!**/.env*"] })],
      HOST,
    );
    expect(patterns).toContain("**/host-vaults/**");
    expect(patterns).toContain("**/notes.txt");
    expect(patterns).not.toContain("**/.env*");
  });

  it("gives the default patterns and the host paths when the configuration is invalid", () => {
    const patterns = protectedPatterns([write({ protectedPaths: 3 })], HOST);
    expect(patterns).toContain("**/.env*");
    expect(patterns).toContain("**/host-vaults/**");
  });
});
