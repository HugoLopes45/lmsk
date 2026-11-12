import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRecord } from "../../src/core/index.ts";
import { type Harness, type HarnessOptions, harness } from "./harness.ts";
import {
  type CanaryClass,
  CLASS_IDS,
  type ClassId,
  buildCanaries,
  countAll,
  ENV_RULE_ID,
  ENV_VAR_NAME,
  LITERAL_RULE_ID,
  lineFor,
  type SinkCounts,
} from "./leak-baseline.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
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

interface Observed {
  providerTurns: number;
  repliesRemaining: number;
  roles: Record<string, number>;
  leakTotals: { payload: number };
}

let previousEnv: string | undefined;

const entrypoint = fileURLToPath(
  new URL("../../src/pi/extension.ts", import.meta.url),
);

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

function observe(h: Harness): Observed {
  return {
    providerTurns: h.provider.bodies.length,
    repliesRemaining: h.provider.replies.length,
    roles: roleCounts(h.provider.bodies),
    leakTotals: {
      payload: leakTotal(countAll(Buffer.from(h.sent(), "utf8"), canaries)),
    },
  };
}

interface ScenarioSpec {
  options: Partial<HarnessOptions>;
  files?: Record<string, string>;
  drive: (h: Harness) => Promise<void>;
  checks?: (h: Harness, observed: Observed) => Check[];
}

/** Runs one scenario and fails on a canary leak or a failed scenario check. */
async function runScenario(spec: ScenarioSpec): Promise<void> {
  const h = await harness({
    extensions: [],
    entrypoint,
    persist: true,
    ...spec.options,
    files: spec.files,
  });
  try {
    // Fault scenarios reject the prompt on purpose; the checks judge the outcome.
    await spec.drive(h).catch(() => undefined);
    const observed = observe(h);
    const checks: Check[] = [
      {
        name: "no raw, base64 or percent canary in provider payload",
        passed: observed.leakTotals.payload === 0,
        detail: `${observed.leakTotals.payload} literal occurrences`,
      },
      ...(spec.checks?.(h, observed) ?? []),
    ];
    expect(
      checks
        .filter((check) => !check.passed)
        .map((check) => `${check.name}: ${check.detail}`),
    ).toEqual([]);
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

beforeAll(() => {
  previousEnv = process.env[ENV_VAR_NAME];
  process.env[ENV_VAR_NAME] = canaryOf("C13").value;
});

afterAll(() => {
  if (previousEnv === undefined) delete process.env[ENV_VAR_NAME];
  else process.env[ENV_VAR_NAME] = previousEnv;
});

describe("leak baseline measurement", () => {
  it(
    "successful run: prompt, read, write, edit and assistant echo",
    async () => {
      const writeTarget = "written.txt";
      const editTarget = "edit-target.txt";
      await runScenario({
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
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "compaction and tree summary carry masked instructions",
    async () => {
      await runScenario({
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        drive: async (h) => {
          // Manual compaction keeps one message (keepRecentTokens 1), so the cut falls inside the last turn: pi makes a history call and a turn-prefix call.
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
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed on invalid configuration without a provider body",
    async () => {
      await runScenario({
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
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed on a block rule without a provider body",
    async () => {
      await runScenario({
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
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "records a provider disconnect",
    async () => {
      await runScenario({
        options: { globalConfig: MEASURE_GLOBAL_CONFIG },
        drive: async (h) => {
          h.provider.replies.push({ disconnect: true });
          await h.session.prompt(`Keep ${sourceText}`);
        },
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed on an oversized payload without a provider body",
    async () => {
      await runScenario({
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
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails closed when the scanner result misses its deadline",
    async () => {
      // The harness does not capture the notice code, so the timing shows that the scanner deadline caused the block.
      let elapsedMs = 0;
      await runScenario({
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
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "control: the same stall config lets a short prompt reach the provider",
    async () => {
      await runScenario({
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
    },
    SCENARIO_TIMEOUT_MS,
  );
});
