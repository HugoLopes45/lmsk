import type {
  BeforeProviderRequestEvent,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  ModelRegistry,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
  SessionMessageEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolExecutionEndEvent,
  ToolInfo,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

/** A session entry as the hook reads it: the custom entries, and the messages for `/lmsk reveal`. */
export interface BranchRecord {
  type: string;
  customType?: string;
  data?: unknown;
  message?: SessionMessageEntry["message"];
}

/** The part of the extension context this extension uses. */
export interface HookContext {
  cwd: string;
  isProjectTrusted(): boolean;
  abort(): void;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  sessionManager: { getBranch(): readonly BranchRecord[] };
  modelRegistry: Pick<ModelRegistry, "classify" | "generateImages">;
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
  tool_result: Handler<ToolResultEvent, ToolResultEventResult>;
  tool_execution_end: Handler<ToolExecutionEndEvent>;
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
  session_tree: Handler<SessionTreeEvent>;
  session_shutdown: Handler<SessionShutdownEvent>;
}

/** The part of the extension API this extension uses. */
export interface HookApi {
  on<E extends keyof HookHandlers>(event: E, handler: HookHandlers[E]): void;
  appendEntry(customType: string, data: unknown): void;
  getAllTools(): Pick<ToolInfo, "name" | "sourceInfo">[];
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: HookContext) => Promise<void>;
    },
  ): void;
}
