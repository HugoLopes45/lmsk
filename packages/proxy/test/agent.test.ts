import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/index.ts";

describe("runAgent", () => {
  it.each([
    [{ NO_PROXY: "corp.example" }, ["corp.example", "corp.example"]],
    [{ no_proxy: "corp.example" }, ["corp.example", "corp.example"]],
    [
      { NO_PROXY: "a.example", no_proxy: "b.example" },
      ["a.example", "b.example"],
    ],
  ])(
    "exempts the loopback proxy from an HTTP proxy, and keeps the user's exemptions %o in both spellings, since tools read one or the other",
    async (exemptions, kept) => {
      const dir = mkdtempSync(join(tmpdir(), "lmsk-agent-"));
      const out = join(dir, "env.json");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.env.NO_PROXY, process.env.no_proxy]))`;

      const code = await runAgent(process.execPath, ["-e", script], {
        cwd: dir,
        env: { HTTP_PROXY: "http://proxy.example:3128", ...exemptions },
        notify: () => undefined,
      });

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(
        kept.map((hosts) => `${hosts},127.0.0.1`),
      );
    },
  );
});
