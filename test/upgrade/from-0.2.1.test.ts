import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Guard, type HostContext, isRecord } from "../../src/core/index.ts";
import { allFormats } from "../../src/formats/index.ts";

/** Written by the 0.2.1 package from `scripts/make-upgrade-fixture.ts`. */
const FIXTURE = fileURLToPath(
  new URL("../fixtures/upgrade-0.2.1/", import.meta.url),
);
/** The 0.2.1 store folders: the state folder of the proxy, and the pi folder. */
const STORE_FOLDERS = ["state/lmsk/vaults", "agent/lmsk-vaults"];
const TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const REALS = ["FIXTURE-REAL-VALUE-0001", "FixtureReal1"];
/** Keep equal to `SAMPLE` in `scripts/make-upgrade-fixture.ts`. */
const SAMPLE = "ref FIXTURE-REAL-VALUE-0001 fixtureField=FixtureReal1";

interface Copy {
  config: string;
  stateDir: string;
  stores: string[];
}

const guards: Guard[] = [];

// Closing a guard stops its scanner worker. Temp folders stay: this suite never deletes.
afterEach(() => {
  for (const guard of guards.splice(0)) guard.close();
});

/** A fresh copy of the fixture, so that the current code writes only into the copy. */
function copyFixture(): Copy {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-"));
  cpSync(FIXTURE, dir, { recursive: true });
  // The current code refuses a state folder that is not owner-only.
  chmodSync(join(dir, "state", "lmsk"), 0o700);
  return {
    config: join(dir, "agent", "lmsk", "config.json"),
    stateDir: join(dir, "state", "lmsk"),
    stores: STORE_FOLDERS.map((folder) => join(dir, folder)),
  };
}

/** Opens the current guard on the copy. It loads the 0.2.1 configuration unless `configPaths` says otherwise. */
function openGuard(
  copy: Copy,
  configPaths = [copy.config],
): { guard: Guard; notices: string[] } {
  const notices: string[] = [];
  const ctx: HostContext = {
    ui: {
      notify: (message) => {
        notices.push(message);
      },
    },
    abort: () => undefined,
  };
  const guard = new Guard({
    name: "upgrade-test",
    tools: TOOLS,
    protectedPaths: [],
    format: allFormats,
  });
  guards.push(guard);
  guard.open(
    () => ({
      configPaths,
      projectConfigPath: undefined,
      stateDir: copy.stateDir,
      env: {},
      defaultRules: [],
    }),
    ctx,
  );
  return { guard, notices };
}

/** The `[real, fake]` pair of an entry, as 0.2.1 writes it. */
function pairOf(value: unknown): [real: string, fake: string] {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  )
    return [value[0], value[1]];
  throw new Error("an entry of a 0.2.1 store is not a [real, fake] pair");
}

/** The entries of every 0.2.1 store file in `folder`. */
function entriesIn(folder: string): [real: string, fake: string][] {
  return readdirSync(folder).flatMap((name) => {
    const data: unknown = JSON.parse(readFileSync(join(folder, name), "utf8"));
    if (!isRecord(data) || !Array.isArray(data.entries))
      throw new Error(`${name} is not a 0.2.1 store`);
    return data.entries.map(pairOf);
  });
}

/** The text of each file of the 0.2.1 stores, by path. */
function storeFiles(copy: Copy): Map<string, string> {
  const files = new Map<string, string>();
  for (const folder of copy.stores)
    for (const name of readdirSync(folder))
      files.set(join(folder, name), readFileSync(join(folder, name), "utf8"));
  return files;
}

describe("upgrade from 0.2.1", () => {
  it("fixture check: the 0.2.1 stores hold the sample reals", () => {
    const copy = copyFixture();
    for (const folder of copy.stores)
      expect(entriesIn(folder).map(([real]) => real)).toEqual(
        expect.arrayContaining(REALS),
      );
  });

  it("loads the 0.2.1 configuration and masks the sample reals", async () => {
    const { guard, notices } = openGuard(copyFixture());

    const masked = await guard.maskText(SAMPLE);

    expect(notices).toEqual([]);
    for (const real of REALS) expect(masked).not.toContain(real);
    expect(masked).toHaveLength(SAMPLE.length);
  });

  it("masks nothing without the 0.2.1 rules", async () => {
    const { guard } = openGuard(copyFixture(), []);

    expect(await guard.maskText(SAMPLE)).toBe(SAMPLE);
  });

  it("masks and restores its own fakes, and leaves the 0.2.1 files unchanged", async () => {
    const copy = copyFixture();
    const before = storeFiles(copy);
    const { guard } = openGuard(copy);

    const masked = await guard.maskText(SAMPLE);

    for (const real of REALS) expect(masked).not.toContain(real);
    expect(guard.restoreText(masked)).toBe(SAMPLE);
    expect(storeFiles(copy)).toEqual(before);
  });

  it("restores a 0.2.1 fake unchanged, also after the sample is masked", async () => {
    const copy = copyFixture();
    const { guard } = openGuard(copy);
    await guard.maskText(SAMPLE);
    const fakes = copy.stores.flatMap(entriesIn).map(([, fake]) => fake);

    expect(fakes).not.toEqual([]);
    for (const fake of fakes) expect(guard.restoreText(fake)).toBe(fake);
  });
});
