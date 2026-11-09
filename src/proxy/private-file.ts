import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { CodedError } from "../core/index.ts";

/** The parsed JSON in `path`, or `undefined` when there is no file. A file that is not JSON throws `code`. */
export function readJson(path: string, code: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CodedError(code);
  }
}

/** Replaces `path` in one step. Each writer has its own temp file, so two runs never write into one. */
export function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
