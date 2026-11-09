import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRecord, Scanner } from "@hugolopes45/lmsk-core";
import { type Harness, type HarnessOptions, harness } from "./harness.ts";
import {
  type CanaryClass,
  CLASS_IDS,
  CLEAN_CORPUS,
  type ClassId,
  buildCanaries,
  corpusFindings,
  countAll,
  effectiveRules,
  ENV_RULE_ID,
  ENV_VAR_NAME,
  type FileFinding,
  LITERAL_RULE_ID,
  lineFor,
  readDirBytes,
  rulePatterns,
  scanAttributed,
  type SinkCounts,
} from "./leak-baseline.ts";

// Measurement only. Each scenario records what the real extension let through. Expected
// failures are recorded as RED checks. The result files are written in afterAll, even when checks fail.
const OUT_DIR =
  process.env.PMS_LEAK_OUT_DIR ?? join(tmpdir(), "pms-leak-baseline-out");
const SCENARIO_TIMEOUT_MS = 120_000;
const SCAN_TIMEOUT_MS = 5000;
const SCAN_STALL_TIMEOUT_MS = 300;

const canaries = buildCanaries();
const canaryOf = (id: ClassId): CanaryClass => {
  const canary = canaries.find((entry) => entry.id === id);
  if (!canary) throw new Error(`missing canary ${id}`);
  return canary;
};
const sourceText = `${canaries.map((canary) => lineFor(canary)).join("\n")}\n`;
const editValue = canaries.map((canary) => canary.value).join(" ; ");
const EDIT_MARKER = "EDIT_MARKER_ORIGINAL";
const MEASURE_GLOBAL_CONFIG = JSON.stringify({
  rules: [
    {
      id: LITERAL_RULE_ID,
      type: "literal",
      values: [canaryOf("C12").value],
    },
    { id: ENV_RULE_ID, type: "env", vars: [ENV_VAR_NAME] },
  ],
});
/** Measurement rules plus a nested quantifier that cannot match the prompt, so its scan runs past the deadline. */
const SCAN_STALL_CONFIG = JSON.stringify({
  rules: [
    { id: LITERAL_RULE_ID, type: "literal", values: [canaryOf("C12").value] },
    { id: ENV_RULE_ID, type: "env", vars: [ENV_VAR_NAME] },
    { id: "scan-stall", type: "regex", pattern: "(a+)+b" },
  ],
  scanTimeoutMs: SCAN_STALL_TIMEOUT_MS,
});
const BLOCK_GLOBAL_CONFIG = JSON.stringify({
  rules: [
    {
      id: LITERAL_RULE_ID,
      type: "literal",
      strategy: "block",
      values: [canaryOf("C12").value],
    },
  ],
});

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

interface LeakLocation {
  where: string;
  classes: Record<string, number>;
}

interface SinkTable {
  payload: Record<ClassId, SinkCounts>;
  session: Record<ClassId, SinkCounts>;
  /** Expected to hold plaintext at rest: the vault maps reals to fakes. Reported, not counted as a leak. */
  vault: Record<ClassId, SinkCounts>;
}

interface Scenario {
  id: string;
  kind: "success" | "fault";
  path: string;
  promptOutcome: string;
  providerTurns: number;
  repliesRemaining: number;
  roles: Record<string, number>;
  sinks: SinkTable;
  sessionBytes: number;
  vaultFiles: string[];
  leakTotals: { payload: number; session: number };
  leaks: { payload: LeakLocation[]; session: LeakLocation[] };
  checks: Check[];
  notes: string[];
}

const scenarios: Scenario[] = [];
let directDetection: {
  id: ClassId;
  expectedRule: string;
  detected: boolean;
}[] = [];
let cleanFindings: Awaited<ReturnType<typeof corpusFindings>> | undefined;
let previousEnv: string | undefined;

/** The production entrypoint of this checkout. `LMSK_E2E_ENTRYPOINT` replaces it for a frozen snapshot. */
const entrypoint =
  process.env.LMSK_E2E_ENTRYPOINT ??
  fileURLToPath(new URL("../extensions/index.ts", import.meta.url));

function leakTotal(table: Record<ClassId, SinkCounts>): number {
  return CLASS_IDS.reduce(
    (sum, id) =>
      sum + table[id].raw + table[id].base64 + (table[id].percent ?? 0),
    0,
  );
}

function roleCounts(bodies: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const body of bodies) {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.messages))
      throw new Error("provider body has no messages array");
    for (const message of parsed.messages) {
      const role =
        isRecord(message) && typeof message.role === "string"
          ? message.role
          : "invalid";
      counts[role] = (counts[role] ?? 0) + 1;
    }
  }
  return counts;
}

/** Raw literal occurrences of each canary in one unit of text, listed only when present. */
function rawLocations(text: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const canary of canaries) {
    const count = text.split(canary.value).length - 1;
    if (count > 0) found[canary.id] = count;
  }
  return found;
}

/** Where raw canaries sit in provider bodies: by body and message. Only leaking units are listed. */
function locatePayload(bodies: string[]): LeakLocation[] {
  return bodies.flatMap((body, bodyIndex) => {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.messages))
      throw new Error("provider body has no messages array");
    return parsed.messages.flatMap((message: unknown, messageIndex: number) => {
      const found = rawLocations(JSON.stringify(message));
      if (Object.keys(found).length === 0) return [];
      const role =
        isRecord(message) && typeof message.role === "string"
          ? message.role
          : "invalid";
      return [
        {
          where: `body ${bodyIndex} message ${messageIndex} (${role})`,
          classes: found,
        },
      ];
    });
  });
}

/** Where raw canaries sit in the session JSONL: by line and entry type. */
function locateSession(text: string): LeakLocation[] {
  return text.split("\n").flatMap((line, index) => {
    const found = rawLocations(line);
    if (Object.keys(found).length === 0) return [];
    let type = "unparsed";
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry) && typeof entry.type === "string") type = entry.type;
      if (
        isRecord(entry) &&
        isRecord(entry.message) &&
        typeof entry.message.role === "string"
      )
        type = `${type}/${entry.message.role}`;
    } catch {
      type = "unparsed";
    }
    return [{ where: `session line ${index} (${type})`, classes: found }];
  });
}

function observe(
  h: Harness,
): Pick<
  Scenario,
  | "providerTurns"
  | "repliesRemaining"
  | "roles"
  | "sinks"
  | "sessionBytes"
  | "vaultFiles"
  | "leakTotals"
  | "leaks"
> {
  const payload = Buffer.from(h.sent(), "utf8");
  const sessionFile = h.session.sessionManager.getSessionFile();
  if (sessionFile === undefined) throw new Error("session is not file-backed");
  const session = readFileSync(sessionFile);
  const vault = readDirBytes(join(h.agentDir, "lmsk-vaults"));
  const sessionText = session.toString("utf8");
  const sinks: SinkTable = {
    payload: countAll(payload, canaries),
    session: countAll(session, canaries),
    vault: countAll(vault.buffer, canaries),
  };
  return {
    providerTurns: h.provider.bodies.length,
    repliesRemaining: h.provider.replies.length,
    roles: roleCounts(h.provider.bodies),
    sinks,
    sessionBytes: session.length,
    vaultFiles: vault.files,
    leakTotals: {
      payload: leakTotal(sinks.payload),
      session: leakTotal(sinks.session),
    },
    leaks: {
      payload: locatePayload(h.provider.bodies),
      session: locateSession(sessionText),
    },
  };
}

interface ScenarioSpec {
  id: string;
  kind: Scenario["kind"];
  path: string;
  options: Partial<HarnessOptions>;
  files?: Record<string, string>;
  drive: (h: Harness) => Promise<void>;
  checks?: (h: Harness, observed: ReturnType<typeof observe>) => Check[];
  notes?: string[];
}

async function runScenario(spec: ScenarioSpec): Promise<Scenario> {
  const h = await harness({
    extensions: [],
    entrypoint,
    persist: true,
    ...spec.options,
    files: spec.files,
  });
  let promptOutcome = "resolved";
  try {
    await spec.drive(h);
  } catch (error) {
    promptOutcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const observed = observe(h);
    const checks = spec.checks?.(h, observed) ?? [];
    const scenario: Scenario = {
      id: spec.id,
      kind: spec.kind,
      path: spec.path,
      promptOutcome,
      ...observed,
      checks: [
        {
          name: "no raw, base64 or percent canary in provider payload",
          passed: observed.leakTotals.payload === 0,
          detail: `${observed.leakTotals.payload} literal occurrences`,
        },
        {
          name: "no raw, base64 or percent canary in session JSONL",
          passed: observed.leakTotals.session === 0,
          detail: `${observed.leakTotals.session} literal occurrences`,
        },
        ...checks,
      ],
      notes: spec.notes ?? [],
    };
    scenarios.push(scenario);
    return scenario;
  } finally {
    await h.dispose();
  }
}

/** Summary calls and the library prompt text that only that call carries. */
const SUMMARY_CALLS: [string, string][] = [
  ["compaction history", "Create a structured context checkpoint summary"],
  ["compaction turn prefix", "earlier context from an ongoing conversation"],
  ["branch summary", "Create a structured summary of this conversation branch"],
];
const EXPECTED_S2_CALLS = [
  "prompt",
  "prompt",
  "prompt",
  "prompt",
  "compaction history",
  "compaction turn prefix",
  "branch summary",
];

/** Kind of each provider request: `prompt`, or the summary call whose library prompt it carries. */
function requestKinds(bodies: string[]): string[] {
  return bodies.map((body) => {
    const matched = SUMMARY_CALLS.filter(([, marker]) => body.includes(marker));
    if (matched.length > 1)
      throw new Error("request carries two summary prompts");
    return matched[0]?.[0] ?? "prompt";
  });
}

function summaryOf(
  h: Harness,
  type: "compaction" | "branch_summary",
): string | undefined {
  for (const entry of h.session.sessionManager.getEntries())
    if (entry.type === type) return entry.summary;
  return undefined;
}

function expectChecks(scenario: Scenario): void {
  const failed = scenario.checks.filter((check) => !check.passed);
  expect(
    failed.map((check) => `${check.name}: ${check.detail}`),
    `${scenario.id} RED checks`,
  ).toEqual([]);
}

beforeAll(() => {
  previousEnv = process.env[ENV_VAR_NAME];
  process.env[ENV_VAR_NAME] = canaryOf("C13").value;
  const rules = effectiveRules({
    rules: [
      { id: LITERAL_RULE_ID, type: "literal", values: [canaryOf("C12").value] },
      { id: ENV_RULE_ID, type: "env", vars: [ENV_VAR_NAME] },
    ],
  });
  const scanner = new Scanner(SCAN_TIMEOUT_MS);
  return (async () => {
    try {
      const spans = await scanAttributed(
        scanner,
        rulePatterns(rules, { [ENV_VAR_NAME]: canaryOf("C13").value }),
        canaries.map((canary) => lineFor(canary)),
      );
      directDetection = canaries.map((canary, index) => ({
        id: canary.id,
        expectedRule: canary.expectedRule,
        detected: spans[index].some(
          (span) =>
            span.ruleId === canary.expectedRule &&
            lineFor(canary).slice(span.start, span.end).includes(canary.value),
        ),
      }));
    } finally {
      scanner.close();
    }
  })();
});

afterAll(() => {
  if (previousEnv === undefined) delete process.env[ENV_VAR_NAME];
  else process.env[ENV_VAR_NAME] = previousEnv;
  mkdirSync(OUT_DIR, { recursive: true });
  const results = {
    entrypoint,
    classes: canaries.map((canary) => ({
      id: canary.id,
      name: canary.name,
      expectedRule: canary.expectedRule,
      valueSha256: sha256(canary.value),
      valueLength: canary.value.length,
    })),
    directDetection,
    scenarios,
    cleanSource: cleanFindings ?? null,
  };
  writeFileSync(
    join(OUT_DIR, "pms-leak-baseline.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  writeFileSync(
    join(OUT_DIR, "pms-leak-baseline-report.md"),
    renderReport(results),
  );
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function renderSinkRows(table: SinkTable): string[] {
  return CLASS_IDS.map((id) => {
    const p = table.payload[id];
    const s = table.session[id];
    const v = table.vault[id];
    const cell = (c: SinkCounts) => `${c.raw}/${c.base64}/${c.percent ?? "-"}`;
    return `| ${id} | ${cell(p)} | ${cell(s)} | ${cell(v)} |`;
  });
}

type ReportResults = {
  classes: { id: ClassId; name: string; expectedRule: string }[];
  directDetection: { id: ClassId; expectedRule: string; detected: boolean }[];
  scenarios: Scenario[];
  cleanSource: Awaited<ReturnType<typeof corpusFindings>> | null;
};

function renderDetection(results: ReportResults): string[] {
  const lines = [
    "## Direct detection (gate for zero-leak results)",
    "",
    "| Class | Name | Expected rule | Detected |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of results.directDetection) {
    const meta = results.classes.find((entry) => entry.id === row.id);
    lines.push(
      `| ${row.id} | ${meta?.name ?? ""} | ${row.expectedRule} | ${row.detected ? "yes" : "no"} |`,
    );
  }
  return [...lines, ""];
}

function renderScenario(scenario: Scenario): string[] {
  const lines = [
    `## Scenario ${scenario.id} (${scenario.kind})`,
    "",
    `Path: ${scenario.path}. Prompt outcome: ${scenario.promptOutcome}.`,
    `Provider turns: ${scenario.providerTurns}. Replies remaining: ${scenario.repliesRemaining}. Roles: ${JSON.stringify(scenario.roles)}.`,
    `Session bytes: ${scenario.sessionBytes}. Vault files: ${scenario.vaultFiles.length}.`,
    "",
    "| Class | Payload raw/b64/pct | Session raw/b64/pct | Vault raw/b64/pct (expected at rest) |",
    "| --- | --- | --- | --- |",
    ...renderSinkRows(scenario.sinks),
    "",
    "Leaking locations:",
    "",
  ];
  const leaking = [...scenario.leaks.payload, ...scenario.leaks.session];
  if (leaking.length === 0) lines.push("- none");
  for (const location of leaking)
    lines.push(`- ${location.where}: ${JSON.stringify(location.classes)}`);
  lines.push("", "| Check | Result | Detail |", "| --- | --- | --- |");
  for (const check of scenario.checks)
    lines.push(
      `| ${check.name} | ${check.passed ? "passed" : "RED"} | ${check.detail} |`,
    );
  for (const note of scenario.notes) lines.push("", `Note: ${note}`);
  return [...lines, ""];
}

function renderClean(cleanSource: ReportResults["cleanSource"]): string[] {
  const lines = ["## Clean source false positives", ""];
  if (cleanSource === null) return [...lines, "Not run.", ""];
  lines.push(
    `Total raw spans: ${cleanSource.totalSpans}.`,
    "",
    "| File | Bytes | Spans | Masker changed | Spans by rule |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const file of cleanSource.files as FileFinding[])
    lines.push(
      `| ${file.path} | ${file.bytes} | ${file.spans} | ${file.maskerChanged ? "yes" : "no"} | ${JSON.stringify(file.byRule)} |`,
    );
  return [...lines, ""];
}

function renderReport(results: ReportResults): string {
  const lines = [
    "# Leak baseline report",
    "",
    "Source: frozen copy of the current working tree. Canaries are synthetic. Counts are raw/base64/percent literal occurrences.",
    "",
    ...renderDetection(results),
    ...results.scenarios.flatMap(renderScenario),
    ...renderClean(results.cleanSource),
  ];
  return `${lines.join("\n")}\n`;
}

describe("leak baseline measurement", () => {
  it(
    "successful run: prompt, read, write, edit and assistant echo",
    async () => {
      const writeTarget = "written.txt";
      const editTarget = "edit-target.txt";
      const scenario = await runScenario({
        id: "S1-successful-run",
        kind: "success",
        path: "user prompt, read tool result, write and edit tool args, assistant text",
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        files: {
          "source.txt": sourceText,
          [editTarget]: `${EDIT_MARKER}\n`,
        },
        drive: async (h) => {
          h.provider.replies.push(
            { tool: "read", args: { path: "source.txt" } },
            { tool: "write", args: { path: writeTarget, content: sourceText } },
            {
              tool: "edit",
              args: {
                path: editTarget,
                oldText: EDIT_MARKER,
                newText: editValue,
              },
            },
            { text: `Assistant echoes:\n${sourceText}` },
          );
          await h.session.prompt(`User prompt with:\n${sourceText}`);
        },
        checks: (h, observed) => {
          const written = readFileSync(join(h.cwd, writeTarget));
          const edited = readFileSync(join(h.cwd, editTarget));
          return [
            {
              name: "provider turns equal scripted turns (4)",
              passed: observed.providerTurns === 4,
              detail: `${observed.providerTurns} turns`,
            },
            {
              name: "all scripted replies consumed",
              passed: observed.repliesRemaining === 0,
              detail: `${observed.repliesRemaining} remaining`,
            },
            {
              name: "roles user, assistant and tool present in payloads",
              passed:
                (observed.roles.user ?? 0) > 0 &&
                (observed.roles.assistant ?? 0) > 0 &&
                (observed.roles.tool ?? 0) > 0,
              detail: JSON.stringify(observed.roles),
            },
            {
              name: "write tool bytes equal the scripted content",
              passed: written.equals(Buffer.from(sourceText, "utf8")),
              detail: `${written.length} bytes written, ${Buffer.byteLength(sourceText, "utf8")} expected`,
            },
            {
              name: "edit tool bytes equal the scripted replacement",
              passed: edited.equals(Buffer.from(`${editValue}\n`, "utf8")),
              detail: `${edited.length} bytes after edit`,
            },
          ];
        },
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "compaction and tree summary carry masked instructions",
    async () => {
      const scenario = await runScenario({
        id: "S2-compaction-tree",
        kind: "success",
        path: "user prompts, manual compaction of a split turn, tree summary instructions",
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        drive: async (h) => {
          h.provider.replies.push(
            { text: "ack one" },
            { text: "ack two" },
            { text: "ack three" },
            { text: "ack four" },
            { text: "summary history" },
            { text: "summary turn prefix" },
            { text: "summary tree" },
          );
          for (const suffix of ["one", "two", "three", "four"])
            await h.session.prompt(`Keep ${suffix}\n${sourceText}`);
          await h.session.compact(sourceText);
          const first = h.session.sessionManager
            .getEntries()
            .find((entry) => entry.type === "message");
          if (!first) throw new Error("no message entry to navigate to");
          await h.session.navigateTree(first.id, {
            summarize: true,
            customInstructions: sourceText,
          });
        },
        checks: (h, observed) => {
          const kinds = requestKinds(h.provider.bodies);
          return [
            {
              name: "provider calls follow prompts, compaction and tree summary",
              passed:
                JSON.stringify(kinds) === JSON.stringify(EXPECTED_S2_CALLS),
              detail: kinds.join(", "),
            },
            {
              name: "all scripted replies consumed",
              passed: observed.repliesRemaining === 0,
              detail: `${observed.repliesRemaining} remaining`,
            },
            {
              name: "compaction stores the history and turn-prefix replies",
              passed:
                summaryOf(h, "compaction") ===
                "summary history\n\n---\n\n**Turn Context (split turn):**\n\nsummary turn prefix",
              detail: JSON.stringify(summaryOf(h, "compaction")),
            },
            {
              name: "branch summary stores the tree reply",
              passed:
                summaryOf(h, "branch_summary")?.includes("summary tree") ===
                true,
              detail: JSON.stringify(summaryOf(h, "branch_summary")),
            },
          ];
        },
        notes: [
          "Manual compaction keeps one message (keepRecentTokens 1), so the cut falls inside the last turn. pi then makes a history call and a turn-prefix call.",
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "retry path after a provider 503 keeps canaries out of payloads and session",
    async () => {
      const scenario = await runScenario({
        id: "S3-retry",
        kind: "success",
        path: "provider error then retry, user prompt",
        options: { globalConfig: MEASURE_GLOBAL_CONFIG, retry: true },
        drive: async (h) => {
          h.provider.replies.push(
            {
              error: 503,
              message: `upstream rejected ${canaryOf("C01").value}`,
            },
            { text: "after retry" },
          );
          await h.session.prompt(`Retry ${sourceText}`);
        },
        checks: (_h, observed) => [
          {
            name: "provider turns equal scripted turns (2)",
            passed: observed.providerTurns === 2,
            detail: `${observed.providerTurns} turns`,
          },
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed on invalid configuration without a provider body",
    async () => {
      const scenario = await runScenario({
        id: "F1-invalid-config",
        kind: "fault",
        path: "user prompt under invalid global configuration",
        options: { globalConfig: "{" },
        drive: (h) => h.session.prompt(`Keep ${sourceText}`),
        checks: (_h, observed) => [
          {
            name: "no provider body sent",
            passed: observed.providerTurns === 0,
            detail: `${observed.providerTurns} bodies`,
          },
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed on a block rule without a provider body",
    async () => {
      const scenario = await runScenario({
        id: "F2-block-rule",
        kind: "fault",
        path: "user prompt containing a block-rule literal",
        options: { globalConfig: BLOCK_GLOBAL_CONFIG },
        drive: (h) => h.session.prompt(`Keep ${sourceText}`),
        checks: (_h, observed) => [
          {
            name: "no provider body sent",
            passed: observed.providerTurns === 0,
            detail: `${observed.providerTurns} bodies`,
          },
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "records a provider 503 without retry",
    async () => {
      const scenario = await runScenario({
        id: "F3-provider-503",
        kind: "fault",
        path: "user prompt, provider 503 reply",
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        drive: async (h) => {
          h.provider.replies.push({
            error: 503,
            message: `upstream rejected ${canaryOf("C01").value}`,
          });
          await h.session.prompt(`Keep ${sourceText}`);
        },
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "records a provider disconnect",
    async () => {
      const scenario = await runScenario({
        id: "F4-provider-disconnect",
        kind: "fault",
        path: "user prompt, provider disconnect reply",
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        drive: async (h) => {
          h.provider.replies.push({ disconnect: true });
          await h.session.prompt(`Keep ${sourceText}`);
        },
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed on an oversized payload without a provider body",
    async () => {
      const scenario = await runScenario({
        id: "F5-oversized-payload",
        kind: "fault",
        path: "user prompt larger than the payload cap",
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        drive: (h) =>
          h.session.prompt(`${"x".repeat(8 * 1024 * 1024)}\n${sourceText}`),
        checks: (_h, observed) => [
          {
            name: "no provider body sent",
            passed: observed.providerTurns === 0,
            detail: `${observed.providerTurns} bodies`,
          },
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed when the scanner result misses its deadline",
    async () => {
      let elapsedMs = 0;
      const scenario = await runScenario({
        id: "F6-scanner-timeout-proxy",
        kind: "fault",
        path: "user prompt under a catastrophic global regex; scanner result misses its deadline",
        options: { globalConfig: SCAN_STALL_CONFIG },
        drive: async (h) => {
          const started = Date.now();
          try {
            await h.session.prompt(`Keep ${"a".repeat(40)}\n${sourceText}`);
          } finally {
            elapsedMs = Date.now() - started;
          }
        },
        checks: (_h, observed) => [
          {
            name: "no provider body sent",
            passed: observed.providerTurns === 0,
            detail: `${observed.providerTurns} bodies`,
          },
          {
            name: "prompt returned only after the scanner deadline",
            passed: elapsedMs >= SCAN_STALL_TIMEOUT_MS,
            detail: `${elapsedMs} ms`,
          },
        ],
        notes: [
          "Induced by public inputs only: a global regex rule and a prompt. No product hook. The prompt returns after the scanner deadline with no provider body. The notice code is not captured by the harness, so the SCAN_TIMEOUT cause is inferred from timing. This is a timeout proxy, not a measured delivery loss.",
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "control: the same stall config lets a short prompt reach the provider",
    async () => {
      const scenario = await runScenario({
        id: "F6-control-short-prompt",
        kind: "success",
        path: "user prompt with the stall config; prompt short enough to scan in time",
        options: { globalConfig: SCAN_STALL_CONFIG },
        drive: async (h) => {
          h.provider.replies.push({ text: "after control" });
          await h.session.prompt(`Keep ${"a".repeat(5)}\n${sourceText}`);
        },
        checks: (_h, observed) => [
          {
            name: "provider turn sent for the short prompt",
            passed: observed.providerTurns === 1,
            detail: `${observed.providerTurns} turns`,
          },
        ],
      });
      expectChecks(scenario);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it("measures false positives on the clean source corpus", async () => {
    const scanner = new Scanner(SCAN_TIMEOUT_MS);
    try {
      cleanFindings = await corpusFindings(
        CLEAN_CORPUS,
        effectiveRules({}),
        scanner,
        {},
      );
    } finally {
      scanner.close();
    }
    expect(cleanFindings.totalSpans).toBeGreaterThanOrEqual(0);
  });
});
