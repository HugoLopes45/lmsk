import { randomBytes } from "node:crypto";
import {
  type HostDefaults,
  isRecord,
  loadConfig,
  type MaskConfig,
  type Rule,
} from "./config.ts";
import { CodedError, errorCode } from "./errors.ts";
import { Masker } from "./masker.ts";
import type { PayloadFormat } from "./payload.ts";
import { Scanner } from "./scanner.ts";
import {
  createVaultStore,
  loadVaultStore,
  saveVaultStore,
  type StoredVault,
} from "./vault-store.ts";
import { Vault } from "./vault.ts";

/** The record that names the vault store of a conversation. */
export interface VaultReference {
  namespaceId: string;
}

/**
 * The records that the host keeps for the current conversation, such as the active branch of a session tree.
 * They must outlive the process, so that a resumed conversation finds its store.
 */
export interface ReferenceRecords {
  /** The records as `append` published them, and any other data the host gives. */
  read(): readonly unknown[];
  append(reference: VaultReference): void;
}

export interface OpenOptions {
  /** Global configuration files, in merge order. */
  configPaths: readonly string[];
  /** The project configuration file. Pass it only when the project is trusted. */
  projectConfigPath: string | undefined;
  /** The private directory of the vault stores. */
  storeDir: string;
  references: ReferenceRecords;
  /** The environment of the agent's processes. An `env` rule learns its values from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** Rules that the host adds under the configuration, such as `localIdentityRules()`. */
  defaultRules: readonly Rule[];
}

export interface Session {
  masker: Masker;
  vault: Vault;
  scanner: Scanner;
  config: MaskConfig;
  storeDir: string;
  references: ReferenceRecords;
  /** The store at its last saved revision. Undefined until the first mapping is saved. */
  store: StoredVault | undefined;
  /**
   * False for a loaded store until a save of it succeeds. A reload shows the
   * revision, not that its directory entry reached stable storage.
   */
  confirmed: boolean;
}

export type State =
  | { ok: true; session: Session }
  | { ok: false; code: string };

/**
 * The namespace that the references name. Undefined when there is no reference.
 * A record with real mappings from an older version blocks the session: it is not
 * migrated or rewritten.
 */
function referencedNamespace(references: readonly unknown[]): string | undefined {
  const namespaces = new Set<string>();
  for (const data of references) {
    if (isRecord(data) && Array.isArray(data.entries))
      throw new CodedError("VAULT_LEGACY");
    if (!isRecord(data) || typeof data.namespaceId !== "string")
      throw new CodedError("STORE_REFERENCE_INVALID");
    namespaces.add(data.namespaceId);
  }
  if (namespaces.size > 1) throw new CodedError("STORE_REFERENCE_AMBIGUOUS");
  const [namespaceId] = namespaces;
  return namespaceId;
}

/** The store that the references name, loaded at its saved revision. Undefined when there is no reference. */
function restoredStore(
  references: readonly unknown[],
  storeDir: string,
): StoredVault | undefined {
  const namespaceId = referencedNamespace(references);
  return namespaceId === undefined
    ? undefined
    : loadVaultStore(storeDir, namespaceId);
}

/** What the host supplies to every session. */
export interface SessionHost extends Omit<HostDefaults, "rules"> {
  /** The provider fields that masking keeps byte-exact. */
  format: PayloadFormat;
}

export function openSession(options: OpenOptions, host: SessionHost): State {
  const loaded = loadConfig(options.configPaths, options.projectConfigPath, {
    ...host,
    rules: options.defaultRules,
  });
  if (loaded.problems.length > 0) return { ok: false, code: "CONFIG_INVALID" };
  const scanner = new Scanner(loaded.config.scanTimeoutMs);
  try {
    const store = restoredStore(options.references.read(), options.storeDir);
    const vault = new Vault(randomBytes, store?.entries);
    const masker = new Masker(
      loaded.config.rules,
      scanner,
      vault,
      options.env,
      host.format,
    );
    return {
      ok: true,
      session: {
        masker,
        vault,
        scanner,
        config: loaded.config,
        storeDir: options.storeDir,
        references: options.references,
        store,
        confirmed: store === undefined,
      },
    };
  } catch (error) {
    scanner.close();
    return { ok: false, code: errorCode(error) };
  }
}

/**
 * Saves the complete mapping at the next revision, also when nothing is new and
 * the loaded store is unconfirmed. The reference is published only after the
 * save, and only when the session has no store yet.
 */
export function persistNewEntries(session: Session): void {
  const entries = session.vault.entries();
  if (
    session.confirmed &&
    entries.length === (session.store?.entries.length ?? 0)
  )
    return;
  const current = session.store ?? createVaultStore(session.storeDir);
  const saved = saveVaultStore(session.storeDir, current, entries);
  if (session.store === undefined)
    session.references.append({ namespaceId: saved.namespaceId });
  session.store = saved;
  session.confirmed = true;
}

/**
 * Makes the host's current records reference the session's store. Records that
 * reference another store fail closed: the session holds one store.
 */
export function attachReferences(session: Session): void {
  const namespaceId = referencedNamespace(session.references.read());
  if (session.store === undefined) {
    if (namespaceId !== undefined)
      throw new CodedError("STORE_REFERENCE_CONFLICT");
    return;
  }
  if (namespaceId === undefined)
    session.references.append({ namespaceId: session.store.namespaceId });
  else if (namespaceId !== session.store.namespaceId)
    throw new CodedError("STORE_REFERENCE_CONFLICT");
}
