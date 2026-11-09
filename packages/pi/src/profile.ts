import { join } from "node:path";
import type { GuardHost } from "@hugolopes45/lmsk-core";
import { allFormats } from "@hugolopes45/lmsk-formats";

/** Starts every notice and names the extension's files. */
export const NAME = "lmsk";
/** Session entry that holds the store reference. Older sessions wrote real mappings under it. */
export const VAULT_ENTRY = `${NAME}/vault`;
/** Directory under the agent home that holds the private mapping stores. */
export const VAULT_STORE_DIR = `${NAME}-vaults`;
/** The global configuration file under the agent home. */
export const GLOBAL_CONFIG = join(NAME, "config.json");
/** The project configuration file under the project directory. */
export const PROJECT_CONFIG = join(".pi", `${NAME}.json`);

/** Pi's core tools, the only tools whose input may be restored, and the extension's own files. */
export const PI_DEFAULTS: Omit<GuardHost, "name"> = {
  tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
  protectedPaths: [
    `**/${VAULT_STORE_DIR}/**`,
    `**/${GLOBAL_CONFIG}`,
    `**/${PROJECT_CONFIG}`,
    // The vaults of `lmsk claude`, wherever XDG_STATE_HOME puts them.
    `**/${NAME}/vaults/**`,
  ],
  format: allFormats,
};
