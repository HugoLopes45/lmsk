import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Writes test/fixtures/upgrade-0.2.1 with the published 0.2.1 package and fake values only. Run `npm run fmt` after it. */

const PACKAGE = "@hugolopes45/lmsk@0.2.1";
const OUT = fileURLToPath(
  new URL("../test/fixtures/upgrade-0.2.1/", import.meta.url),
);
/**
 * 0.2.1 has no package entry: its package.json has no `exports` or `main`. This imports its core
 * barrel, the only module that exports `Guard`. Approved as the one exception to the public-API rule.
 */
const CORE_MODULE = join("dist", "core", "index.js");
/** Pi's core tools, as 0.2.1 hosts them. Restored tools of the config must be among them. */
const TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
/** The files of the 0.2.1 layout, under the fixture folder: the global config and the two stores. */
const CONFIG_PATH = join("agent", "lmsk", "config.json");
const PI_STORE = join("agent", "lmsk-vaults");
const STATE_STORE = join("state", "lmsk", "vaults");
/** The sample text that masking writes into the 0.2.1 stores. Keep it equal to the test. */
const SAMPLE = "ref FIXTURE-REAL-VALUE-0001 fixtureField=FixtureReal1";
/** The rules hold values that no built-in rule detects, so the test shows that these rules mask. */
const CONFIG = {
  rules: [
    {
      id: "fixture-value",
      type: "literal",
      values: ["FIXTURE-REAL-VALUE-0001"],
    },
    {
      id: "fixture-field",
      type: "keyed",
      strategy: "shape",
      keys: ["fixtureField"],
      value: "[A-Za-z0-9]{12}",
    },
  ],
  protectedPaths: ["**/fixture-secrets/**"],
  networkCommands: ["fixture-upload"],
  restoredTools: ["read", "bash"],
  withholdHiddenCopies: true,
  scanTimeoutMs: 2000,
};

interface HostContext021 {
  ui: { notify(message: string, level: string): void };
  abort(): void;
}

interface OpenOptions021 {
  configPaths: string[];
  projectConfigPath: string | undefined;
  storeDir: string;
  references: { read(): unknown[]; append(reference: unknown): void };
  env: Record<string, string | undefined>;
  defaultRules: unknown[];
}

interface Guard021 {
  open(options: () => OpenOptions021, ctx: HostContext021): void;
  maskText(text: string): Promise<string>;
  close(): void;
}

interface Core021 {
  Guard: new (host: {
    name: string;
    tools: string[];
    protectedPaths: string[];
  }) => Guard021;
}

/** Installs the package into a folder of its own, never into this clone. */
function install(work: string): string {
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      work,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      "--cache",
      join(work, "npm-cache"),
      "--logs-dir",
      join(work, "npm-logs"),
      PACKAGE,
    ],
    { stdio: "inherit" },
  );
  return join(work, "node_modules", "@hugolopes45", "lmsk");
}

/** Masks the sample with the 0.2.1 guard, which saves the store under `storeDir`. */
async function writeStore(
  core: Core021,
  configPath: string,
  storeDir: string,
): Promise<void> {
  // 0.2.1 creates the store folder itself, with owner-only mode, under an existing parent.
  mkdirSync(dirname(storeDir), { recursive: true });
  const references: unknown[] = [];
  const ctx: HostContext021 = {
    ui: {
      notify: (message) => {
        throw new Error(message);
      },
    },
    abort: () => {
      throw new Error("the 0.2.1 guard asked to abort");
    },
  };
  const guard = new core.Guard({
    name: "lmsk",
    tools: TOOLS,
    protectedPaths: [],
  });
  guard.open(
    () => ({
      configPaths: [configPath],
      projectConfigPath: undefined,
      storeDir,
      references: {
        read: () => references,
        append: (reference) => {
          references.push(reference);
        },
      },
      env: {},
      defaultRules: [],
    }),
    ctx,
  );
  try {
    await guard.maskText(SAMPLE);
  } finally {
    guard.close();
  }
}

/** Fails when a file of the fixture holds a path of this machine or of a system folder. */
function assertNoLocalPath(dir: string, localRoots: string[]): void {
  const systemPath = /\/(Users|home|root|private|var|tmp)\/|[A-Za-z]:\\/;
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, "utf8");
    if (localRoots.some((root) => text.includes(root)) || systemPath.test(text))
      throw new Error(`${file} holds a local path`);
  }
}

async function main(): Promise<void> {
  if (existsSync(OUT))
    throw new Error(`${OUT} exists; delete it by hand, then run again`);
  // The install folder stays in the system temp folder: this script never deletes.
  const work = mkdtempSync(join(tmpdir(), "lmsk-0.2.1-"));
  const core: Core021 = await import(
    pathToFileURL(join(install(work), CORE_MODULE)).href
  );
  const configPath = join(OUT, CONFIG_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(CONFIG, null, 2)}\n`);
  await writeStore(core, configPath, join(OUT, PI_STORE));
  await writeStore(core, configPath, join(OUT, STATE_STORE));
  assertNoLocalPath(OUT, [work, tmpdir(), homedir()]);
}

await main();
