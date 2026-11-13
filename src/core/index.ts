export {
  type HostDefaults,
  isRecord,
  mergeConfigs,
  protectedPatterns,
  type RawConfig,
  type Rule,
  validateConfig,
} from "./config.ts";
export { CodedError, errorCode } from "./errors.ts";
export {
  Guard,
  type GuardHost,
  type HostContext,
  type Redaction,
  type ToolCall,
} from "./guard.ts";
export { localIdentityRules } from "./identity.ts";
export {
  commandWords,
  fromHome,
  protectedPath,
  shellReadings,
} from "./tool-policy.ts";
export { DEFAULT_MASK, envValues, Masker, MaskError } from "./masker.ts";
export {
  assertPayloadSize,
  type PayloadFormat,
  type TextMap,
  textsOf,
} from "./payload.ts";
export {
  keyedPattern,
  literalPattern,
  type ScanPattern,
  Scanner,
} from "./scanner.ts";
export { Vault } from "./vault.ts";
export { MachineVault } from "./machine-vault.ts";
export { machinePaths, SERVICE_LABEL } from "./paths.ts";
export { TextRestorer } from "./restorer.ts";
