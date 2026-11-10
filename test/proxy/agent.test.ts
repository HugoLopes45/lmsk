import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/proxy/index.ts";

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

  it("ends the agent when lmsk ends on an error, so the agent never sends to a port that another user can take", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmsk-agent-"));
    const out = join(dir, "pid");
    const agent = `require("node:fs").writeFileSync(${JSON.stringify(out)}, String(process.pid)); setInterval(() => undefined, 1000)`;
    const lmsk = `
      import { existsSync } from "node:fs";
      import { runAgent } from ${JSON.stringify(join(import.meta.dirname, "../../src/proxy/agent.ts"))};
      void runAgent(process.execPath, ["-e", ${JSON.stringify(agent)}], { cwd: ${JSON.stringify(dir)}, env: {}, notify: () => undefined });
      const started = setInterval(() => { if (existsSync(${JSON.stringify(out)})) { clearInterval(started); throw new Error("proxy failed"); } }, 10);
    `;
    const parent = spawn(
      process.execPath,
      ["--input-type=module", "-e", lmsk],
      {
        stdio: "ignore",
      },
    );

    await once(parent, "exit");
    const pid = Number(readFileSync(out, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  });
});
