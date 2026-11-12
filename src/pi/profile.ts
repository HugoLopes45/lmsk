import { join } from "node:path";
import type { GuardHost } from "../core/index.ts";
import { allFormats } from "../formats/index.ts";

/** Starts every notice and names the extension's files. */
export const NAME = "lmsk";
/** The global configuration file under the agent home. */
export const GLOBAL_CONFIG = join(NAME, "config.json");
/** The project configuration file under the project directory. */
export const PROJECT_CONFIG = join(".pi", `${NAME}.json`);

/** Pi's core tools, the only tools whose input may be restored, and the project configuration. `machinePaths` protects the other files. */
export const PI_DEFAULTS: Omit<GuardHost, "name"> = {
  tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
  protectedPaths: [`**/${PROJECT_CONFIG}`],
  format: allFormats,
};
