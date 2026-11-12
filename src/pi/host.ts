import type {
  BeforeProviderRequestEvent,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
  SessionMessageEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { GuardedRegistry } from "./guard-runtime.ts";

/** A session entry as the hook reads it: its message, for the call ids and for `/lmsk reveal`. */
export interface BranchRecord {
  /** Not read: without it, a pi entry that has no `message` shares no property and does not type-check. */
  type: string;
  message?: SessionMessageEntry["message"];
}

/** The part of the extension context this extension uses. */
export interface HookContext {
  cwd: string;
  isProjectTrusted(): boolean;
  abort(): void;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  sessionManager: { getBranch(): readonly BranchRecord[] };
  modelRegistry: GuardedRegistry;
}

type Handler<E, R = undefined, C = HookContext> = (
  event: E,
  ctx: C,
) => Promise<R | void> | R | void;

interface HookHandlers {
  session_start: Handler<SessionStartEvent>;
  before_provider_request: Handler<BeforeProviderRequestEvent, unknown>;
  tool_call: Handler<ToolCallEvent, ToolCallEventResult>;
  message_end: Handler<MessageEndEvent, MessageEndEventResult>;
  session_before_compact: Handler<
    SessionBeforeCompactEvent,
    SessionBeforeCompactResult,
    ExtensionContext
  >;
  session_before_tree: Handler<
    SessionBeforeTreeEvent,
    SessionBeforeTreeResult,
    ExtensionContext
  >;
  session_shutdown: Handler<SessionShutdownEvent>;
}

/** The part of the extension API this extension uses. */
export interface HookApi {
  on<E extends keyof HookHandlers>(event: E, handler: HookHandlers[E]): void;
  getAllTools(): Pick<ToolInfo, "name" | "sourceInfo">[];
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: HookContext) => Promise<void>;
    },
  ): void;
}
