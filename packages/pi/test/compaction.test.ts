import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import fc from "fast-check";
import type {
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { compactMasked, summarizeTreeMasked } from "../src/compaction.ts";
import { PI_DEFAULTS } from "../src/profile.ts";
import { Masker, Scanner, Vault } from "@lmsk/core";
import { harness, type Harness } from "./harness.ts";

const SCAN_TIMEOUT_MS = 5000;
const PROPERTY_SEED = 741526;
const PROPERTY_RUNS = 10;
const resources: Harness[] = [];
const scanners: Scanner[] = [];

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const scanner of scanners.splice(0)) scanner.close();
  await Promise.all(resources.splice(0).map((h) => h.dispose()));
});

function maskerFor(secret: string): Masker {
  const scanner = new Scanner(SCAN_TIMEOUT_MS);
  scanners.push(scanner);
  return new Masker(
    [
      {
        id: "canary",
        type: "literal",
        values: [secret],
        enabled: true,
        strategy: "shape",
      },
    ],
    scanner,
    new Vault(randomBytes),
    {},
    PI_DEFAULTS.format,
  );
}

async function history(
  masker: Pick<Masker, "maskPayload">,
  secret: string,
  prepare?: (ctx: ExtensionContext) => void,
) {
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event, ctx) => {
      prepare?.(ctx);
      return compactMasked(event, ctx, masker);
    });
    pi.on("session_before_tree", (event, ctx) =>
      summarizeTreeMasked(event, ctx, masker),
    );
  };
  const h = await harness({ extensions: [extension] });
  resources.push(h);
  // Populate local history without making main-loop requests.
  for (const suffix of ["first", "second", "third", "last"]) {
    h.session.sessionManager.appendMessage({
      role: "user",
      content: `${secret} ${suffix}`,
      timestamp: 0,
    });
  }
  return h;
}

describe("summary egress boundaries", () => {
  it("masks secrets in compaction instructions and abandoned branch history on the wire", async () => {
    const secret = ["SECRET", "VALUE", "123"].join("");
    const masker = maskerFor(secret);
    const h = await history(masker, secret);
    await h.session.compact(`Keep ${secret}`);
    expect(h.provider.bodies.length).toBeGreaterThan(0);
    expect(h.sent()).not.toContain(secret);
    const beforeTree = h.provider.bodies.length;
    const first = h.session.sessionManager
      .getEntries()
      .find((e) => e.type === "message");
    if (!first) throw new Error("missing history fixture");
    const tree = await h.session.navigateTree(first.id, {
      summarize: true,
      customInstructions: secret,
    });
    expect(tree.cancelled).toBe(false);
    expect(tree.summaryEntry).toBeDefined();
    expect(h.provider.bodies.length).toBeGreaterThan(beforeTree);
    expect(h.sent()).not.toContain(secret);
    const [fake] = await masker.mask([secret]);
    expect(fake).toBeDefined();
    expect(h.sent()).toContain(fake);
  });

  it("cancels both summaries without sending a body when the scanner rejects", async () => {
    const secret = ["SECRET", "VALUE", "123"].join("");
    const h = await history(
      {
        maskPayload: async () => {
          throw new Error("SCAN_TIMEOUT");
        },
      },
      secret,
    );
    await expect(h.session.compact()).rejects.toThrow();
    const first = h.session.sessionManager
      .getEntries()
      .find((e) => e.type === "message");
    if (!first) throw new Error("missing history fixture");
    expect(
      (await h.session.navigateTree(first.id, { summarize: true })).cancelled,
    ).toBe(true);
    expect(h.provider.bodies).toEqual([]);
  });

  it("rejects an undefined masking result instead of reusing the original payload", async () => {
    const h = await history(
      { maskPayload: async () => undefined },
      "UNMASKED123456",
    );
    await expect(h.session.compact()).rejects.toThrow("cancelled");
    expect(h.provider.bodies).toEqual([]);
  });

  it("cancels an in-flight scan without sending its eventual result", async () => {
    const started = deferred<void>();
    const release = deferred<unknown>();
    const h = await history(
      {
        maskPayload: async () => {
          started.resolve();
          return release.promise;
        },
      },
      "UNMASKED123456",
    );
    const pending = h.session.compact();
    const assertion = expect(pending).rejects.toThrow();
    await started.promise;
    const aborted = h.session.abort();
    release.resolve({ messages: [] });
    await Promise.all([assertion, aborted]);
    expect(h.provider.bodies).toEqual([]);
  });

  it("rejects remotely aborted partial summaries even when the local signal is active", async () => {
    const h = await history(
      maskerFor("UNMASKED123456"),
      "UNMASKED123456",
      (ctx) => {
        const stream = createAssistantMessageEventStream();
        stream.end(
          fauxAssistantMessage("partial checkpoint", { stopReason: "aborted" }),
        );
        vi.spyOn(ctx.modelRegistry, "streamSimple").mockReturnValueOnce(stream);
      },
    );
    await expect(h.session.compact()).rejects.toThrow("cancelled");
    expect(
      h.session.sessionManager
        .getEntries()
        .some((e) => e.type === "compaction"),
    ).toBe(false);
    expect(h.provider.bodies).toEqual([]);
  });

  it("keeps cancellation when the notification boundary throws", async () => {
    const h = await history(
      {
        maskPayload: async () => {
          throw new Error("SCAN_CRASH");
        },
      },
      "UNMASKED123456",
      (ctx) => {
        vi.spyOn(ctx.ui, "notify").mockImplementation(() => {
          throw new Error("UI unavailable");
        });
      },
    );
    await expect(h.session.compact()).rejects.toThrow("cancelled");
    expect(h.provider.bodies).toEqual([]);
  });

  it("never leaks generated literal canaries through compaction and tree summaries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Z]{12}[0-9]{6}$/),
        async (secret) => {
          const h = await history(maskerFor(secret), secret);
          try {
            await h.session.compact(secret);
            expect(h.provider.bodies.length).toBeGreaterThan(0);
            expect(h.sent()).not.toContain(secret);
            const first = h.session.sessionManager
              .getEntries()
              .find((e) => e.type === "message");
            if (!first) throw new Error("missing history fixture");
            const before = h.provider.bodies.length;
            const result = await h.session.navigateTree(first.id, {
              summarize: true,
              customInstructions: secret,
            });
            expect(result.cancelled).toBe(false);
            expect(h.provider.bodies.length).toBeGreaterThan(before);
            expect(h.sent()).not.toContain(secret);
          } finally {
            await h.dispose();
          }
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });
});
