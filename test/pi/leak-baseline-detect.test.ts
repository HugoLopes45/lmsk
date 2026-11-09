import { describe, expect, it } from "vitest";
import { Scanner } from "../../src/core/index.ts";
import {
  buildCanaries,
  countSink,
  ENV_RULE_ID,
  ENV_VAR_NAME,
  effectiveRules,
  LITERAL_RULE_ID,
  lineFor,
  rulePatterns,
  scanAttributed,
} from "./leak-baseline.ts";

// Direct detection proof: each canary must be found by its expected rule before any
// zero-leak result counts. Without this check a zero-leak result could come from a
// blocked or all-throw run.
const canaries = buildCanaries();

function valueOf(id: string): string {
  const canary = canaries.find((entry) => entry.id === id);
  if (!canary) throw new Error(`missing canary ${id}`);
  return canary.value;
}

/** Last digit plus one, modulo 10. Breaks any checksum that covers that digit. */
function bumpLastDigit(value: string): string {
  return `${value.slice(0, -1)}${(Number(value.slice(-1)) + 1) % 10}`;
}

// Same shape as a canary with a broken checksum, or a non-public address. The validator must reject each.
const NEGATIVE_CONTROLS = [
  { id: "iban", value: bumpLastDigit(valueOf("C06")), expectedRule: "iban" },
  {
    id: "card",
    value: bumpLastDigit(valueOf("C07")),
    expectedRule: "credit-card",
  },
  { id: "nir", value: bumpLastDigit(valueOf("C08")), expectedRule: "fr-nir" },
  { id: "private-ip", value: "10.0.0.1", expectedRule: "ipv4" },
];

const measurementRules = effectiveRules({
  rules: [
    {
      id: LITERAL_RULE_ID,
      type: "literal",
      enabled: true,
      strategy: "mask",
      values: [valueOf("C12")],
    },
    {
      id: ENV_RULE_ID,
      type: "env",
      enabled: true,
      strategy: "mask",
      vars: [ENV_VAR_NAME],
    },
  ],
});
const env = { [ENV_VAR_NAME]: valueOf("C13") };

describe("leak baseline canary detection", () => {
  it("counts a canary inside base64 text at every byte alignment", () => {
    for (const canary of canaries)
      for (const shift of [0, 1, 2]) {
        const carrier = Buffer.concat([
          Buffer.alloc(shift, "A"),
          Buffer.from(canary.value, "utf8"),
          Buffer.alloc(3, "B"),
        ]).toString("base64");
        expect(
          countSink(Buffer.from(carrier, "utf8"), canary).base64,
          `${canary.id} at shift ${shift}`,
        ).toBeGreaterThan(0);
      }
  });

  it("counts a canary inside percent text, or reports no separate form when the two are equal", () => {
    for (const canary of canaries) {
      const encoded = encodeURIComponent(canary.value);
      const counted = countSink(Buffer.from(`x ${encoded} y`, "utf8"), canary);
      if (encoded === canary.value)
        expect(counted.percent, canary.id).toBeNull();
      else expect(counted.percent, canary.id).toBeGreaterThan(0);
    }
  });

  it("does not detect invalid checksums or non-public addresses on the same rule", async () => {
    const scanner = new Scanner(5000);
    try {
      const texts = NEGATIVE_CONTROLS.map(
        (control) => `marker ${control.id} ${control.value}`,
      );
      const spans = await scanAttributed(
        scanner,
        rulePatterns(measurementRules, env),
        texts,
      );
      const falsePositives = NEGATIVE_CONTROLS.flatMap((control, index) =>
        spans[index].some((span) => span.ruleId === control.expectedRule)
          ? [control.id]
          : [],
      );
      expect(falsePositives).toEqual([]);
    } finally {
      scanner.close();
    }
  });

  it("detects every canary on its expected rule with the direct scanner", async () => {
    const scanner = new Scanner(5000);
    try {
      const texts = canaries.map((canary) => lineFor(canary));
      const spans = await scanAttributed(
        scanner,
        rulePatterns(measurementRules, env),
        texts,
      );
      const missing = canaries.flatMap((canary, index) => {
        const hit = spans[index].some(
          (span) =>
            span.ruleId === canary.expectedRule &&
            texts[index].slice(span.start, span.end).includes(canary.value),
        );
        return hit ? [] : [`${canary.id}:${canary.expectedRule}`];
      });
      expect(missing).toEqual([]);
    } finally {
      scanner.close();
    }
  });
});
