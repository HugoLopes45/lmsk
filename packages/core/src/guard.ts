import { DEFAULT_SETTINGS } from "./config.ts";
import { CodedError, errorCode } from "./errors.ts";
import {
  attachReferences,
  type OpenOptions,
  openSession,
  persistNewEntries,
  type Session,
  type SessionHost,
  type State,
} from "./session.ts";
import { isNetworkCommand, isProtectedPath } from "./tool-policy.ts";

export type NoticeLevel = "info" | "warning" | "error";

/** The part of a host event context that the guard uses. */
export interface HostContext {
  ui: { notify(message: string, level: NoticeLevel): void };
  /** Stops the host's current operation, so that no request of it reaches the provider. */
  abort(): void;
}

/** What the host supplies once. */
export interface GuardHost extends SessionHost {
  /** Starts every notice. */
  name: string;
}

export interface MaskOptions {
  /** The reals that the texts' own tool call put back, see `Masker.mask`. */
  restored?: readonly string[];
  /**
   * Rejects with HIDDEN_REAL when a masked text still holds a real: `plain` checks plain
   * copies, `configured` also checks the readings that `withholdHiddenCopies` turns on.
   */
  refuseHidden?: "plain" | "configured";
}

/** A tool call as the host received it. */
export interface ToolCall {
  id: string;
  tool: string;
  /** Restored in place. */
  input: Record<string, unknown>;
  /** The host checked that the tool is its own, not a plugin tool of the same name. */
  verified: boolean;
  /** The input field that holds a shell command. */
  commandKey?: string;
  cwd: string;
  /** The path that the tool opens, read from the input after the restore. */
  path(): string | undefined;
}

/** `off` lasts until the session reopens. */
export type Redaction = "enabled" | "off";

/** Shown with every status and warning, so that users know which data stays raw. */
const HISTORY_NOTE = "Entries written while off stay raw.";

/**
 * The host-independent state of one session: masks run one at a time, mappings
 * are saved, failures close the session, and notices explain it.
 */
export class Guard {
  private readonly host: GuardHost;
  private state: State = { ok: false, code: "NOT_STARTED" };
  private redaction: Redaction = "enabled";
  private reportedStop = false;
  private reportedBlock = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Reals that each verified call put back into its arguments. Kept until the call ends. */
  private readonly restoredByCall = new Map<string, Set<string>>();

  constructor(host: GuardHost) {
    this.host = host;
  }

  /**
   * Closes the earlier session and opens a new one. A failure, also a throw of `options`, blocks
   * masking until the next open.
   */
  open(options: () => OpenOptions, ctx: HostContext): void {
    if (this.state.ok) this.state.session.scanner.close();
    try {
      this.state = openSession(options(), this.host);
    } catch (error) {
      this.state = { ok: false, code: errorCode(error) };
    }
    this.redaction = "enabled";
    this.reportedStop = false;
    this.reportedBlock = false;
    if (!this.state.ok) this.report(ctx, this.state.code);
  }

  /**
   * Makes the host's current records reference the session's store. Call it when they change
   * without a new session. A conflict or a throw of `read` blocks the session.
   */
  attachReferences(ctx: HostContext): void {
    if (!this.state.ok) return;
    const { session } = this.state;
    try {
      attachReferences(session);
    } catch (error) {
      this.block(session, error);
      this.report(ctx, errorCode(error));
    }
  }

  /** Stops the scanner worker so the process can exit. The closed state keeps a later scan from restarting it. */
  close(): void {
    if (this.state.ok) this.state.session.scanner.close();
    this.state = { ok: false, code: "SESSION_SHUTDOWN" };
    this.restoredByCall.clear();
  }

  /** Whether the user turned masking off in a working session. */
  get off(): boolean {
    return this.state.ok && this.redaction === "off";
  }

  /**
   * Restores the fakes in a verified call's input, then blocks the call when its path is protected.
   * The check runs after the restore, so a fake path cannot restore into a protected one. A call
   * that is not blocked keeps its restored reals until `toolResult` or `toolEnd`.
   */
  toolCall(call: ToolCall): { blocked: boolean } {
    const { blocked, reals } = this.restoredBy(call);
    if (reals.length > 0) this.restoredByCall.set(call.id, new Set(reals));
    return { blocked };
  }

  /**
   * Restores a call like `toolCall` and returns the reals put back, but keeps nothing for its result.
   * A host that resends a call's history on every request replays the call to mask that history.
   */
  restoredBy(call: ToolCall): { blocked: boolean; reals: string[] } {
    const restored = call.verified
      ? this.restoreInput(call.tool, call.input, call.commandKey)
      : new Set<string>();
    const path = call.path();
    if (path !== undefined && this.isProtected(path, call.cwd))
      return { blocked: true, reals: [] };
    return { blocked: false, reals: [...restored] };
  }

  /**
   * The masker of a call's result: `maskTexts` with `refuseHidden: "configured"`, which also masks the
   * reals that the call put back, also when they are too short to learn. Call it when the result
   * arrives, before any step that can fail: it takes the reals, so each call's reals serve one result.
   */
  toolResult(callId: string): (texts: string[]) => Promise<string[]> {
    const restored = this.takeRestored(callId);
    return (texts) =>
      this.maskTexts(texts, { restored, refuseHidden: "configured" });
  }

  /** Forgets a call that ends, also one without a result, such as a blocked call. */
  toolEnd(callId: string): void {
    this.restoredByCall.delete(callId);
  }

  /** A blocked session keeps the default paths and the host's own files protected. */
  private isProtected(path: string, cwd: string): boolean {
    const patterns = this.state.ok
      ? this.state.session.config.protectedPaths
      : [...DEFAULT_SETTINGS.protectedPaths, ...this.host.protectedPaths];
    return isProtectedPath(path, cwd, patterns);
  }

  /**
   * Restores fakes in the `input` of a call to `tool`, in place, and returns the reals put back.
   * Call it only for a tool that the host verified as its own. When `input[commandKey]` is a
   * command that sends to the network after restore, `input` keeps its fakes.
   */
  private restoreInput(
    tool: string,
    input: Record<string, unknown>,
    commandKey?: string,
  ): Set<string> {
    const restored = new Set<string>();
    if (!this.state.ok) return restored;
    const { config, masker } = this.state.session;
    if (!config.restoredTools.includes(tool)) return restored;
    const masked = { ...input };
    Object.assign(input, masker.restoreValue(input, restored));
    // After restore, so a masked client name, such as `curl`, is seen too.
    const command = commandKey === undefined ? undefined : input[commandKey];
    if (typeof command === "string" && isNetworkCommand(command, config)) {
      Object.assign(input, masked);
      restored.clear();
    }
    return restored;
  }

  /** The reals that the call put back. Forgets them. */
  private takeRestored(callId: string): string[] {
    const reals = this.restoredByCall.get(callId);
    this.restoredByCall.delete(callId);
    return reals === undefined ? [] : [...reals];
  }

  /** Runs `run` when the session is open. A blocked session or a throw returns `fail` with its code. */
  async guarded<C extends HostContext, R>(
    ctx: C,
    fail: (ctx: C, code: string) => NoInfer<R>,
    run: () => Promise<R>,
  ): Promise<R> {
    if (!this.state.ok) return fail(ctx, this.state.code);
    try {
      return await run();
    } catch (error) {
      return fail(ctx, errorCode(error));
    }
  }

  /**
   * Masks, saves, then returns the masked output. Masks run one at a time, so no
   * other mapping can change the saved snapshot. A queued mask fails, and saves
   * nothing, when the session is blocked or replaced during the mask. A failed save blocks the session until
   * it reopens: the save may have committed.
   */
  private exclusive<T>(session: Session, mask: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (!this.state.ok) throw new CodedError(this.state.code);
      // A replaced session's closed scanner fails its late mask; that failure belongs to no live session.
      const masked = await mask().catch((error: unknown) => {
        throw this.state.ok && this.state.session === session
          ? error
          : new CodedError("SESSION_CHANGED");
      });
      if (!this.state.ok || this.state.session !== session)
        throw new CodedError("SESSION_CHANGED");
      try {
        persistNewEntries(session);
      } catch (error) {
        this.block(session, error);
        throw error;
      }
      return masked;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The open session. Throws the block code when the session is blocked. */
  private session(): Session {
    if (!this.state.ok) throw new CodedError(this.state.code);
    return this.state.session;
  }

  /**
   * Masks a provider payload, and returns it unchanged while masking is off. Rejects when the session is blocked.
   * `restored` holds the reals that the tool calls in the payload put back, see `restoredBy`.
   * Masking keeps a secret glued to a word, such as `build_<secret>`, so a glued real rejects.
   */
  readonly maskPayload = async (
    payload: unknown,
    restored: readonly string[] = [],
  ): Promise<unknown> => this.maskPayloadIn(this.session(), payload, restored);

  /**
   * A payload masker bound to the open session, for work that outlives one event, such as a summary.
   * Throws when the session is blocked. Its masks reject with SESSION_CHANGED once another session opens.
   */
  payloadMasker(): { maskPayload(payload: unknown): Promise<unknown> } {
    const session = this.session();
    return { maskPayload: (payload) => this.maskPayloadIn(session, payload) };
  }

  private async maskPayloadIn(
    session: Session,
    payload: unknown,
    restored: readonly string[] = [],
  ): Promise<unknown> {
    if (this.off) return payload;
    return this.exclusive(session, async () => {
      const masked = await session.masker.maskPayload(payload, restored);
      await session.masker.assertNoHiddenRealInPayload(
        session.masker.payloadTexts(masked),
      );
      return masked;
    });
  }

  /**
   * Masks `texts` and returns them in input order, and unchanged while masking is off.
   * Rejects when the session is blocked, and with HIDDEN_REAL as `refuseHidden` asks.
   */
  async maskTexts(
    texts: string[],
    options: MaskOptions = {},
  ): Promise<string[]> {
    const session = this.session();
    if (this.off) return texts;
    return this.exclusive(session, async () => {
      const masked = await session.masker.mask(texts, options.restored);
      if (options.refuseHidden !== undefined)
        await session.masker.assertNoHiddenReal(
          masked,
          options.refuseHidden === "configured" &&
            session.config.withholdHiddenCopies,
        );
      return masked;
    });
  }

  /** The tool results of a masked payload that hold a hidden real, as `toolResult` checks them. */
  async hidingResults(results: readonly unknown[]): Promise<Set<unknown>> {
    const session = this.session();
    if (this.off) return new Set();
    return this.exclusive(session, () =>
      session.masker.hidingResults(
        results,
        session.config.withholdHiddenCopies,
      ),
    );
  }

  /** Masks one text, such as a model call input, and refuses a plain hidden real. */
  readonly maskText = async (text: string): Promise<string> => {
    const [masked] = await this.maskTexts([text], { refuseHidden: "plain" });
    return masked;
  };

  /**
   * Shows one notice per session for a stopped request and one for a blocked session, so that
   * neither repeats on each request and a stopped request does not hide a later block.
   */
  readonly report = (ctx: HostContext, code: string): void => {
    // A replaced session's late mask must not use up the notice of the new session.
    if (code === "SESSION_CHANGED") return;
    if (!this.state.ok) {
      if (this.reportedBlock) return;
      this.reportedBlock = true;
      ctx.ui.notify(
        `${this.host.name}: ${this.state.code}. Requests that need masking are blocked.`,
        "error",
      );
      return;
    }
    if (this.reportedStop) return;
    this.reportedStop = true;
    ctx.ui.notify(
      `${this.host.name}: ${code}. The request was stopped. Masking stays on.`,
      "error",
    );
  };

  /** The abort keeps withheld text from reaching a provider request of the current operation. */
  failClosed(ctx: HostContext, code: string, notify = this.report): void {
    abortSafely(ctx);
    notifySafely(() => notify(ctx, code));
  }

  /** The masking state for the user: enabled, off or blocked with its code. */
  status(): string {
    if (!this.state.ok)
      return `${this.host.name}: blocked (${this.state.code}). Requests that need masking are blocked until the session reloads.`;
    if (this.redaction === "off") return this.offNotice();
    return `${this.host.name}: enabled. ${HISTORY_NOTE}`;
  }

  /** Turns masking on or off and returns the notice for the user. Throws the code of a blocked session: only a reopen clears a block. */
  setRedaction(next: Redaction): string {
    this.session();
    this.redaction = next;
    return next === "off"
      ? this.offNotice()
      : `${this.host.name}: enabled. Masking on does not clean entries written while off.`;
  }

  /**
   * The text with the real value in place of each known fake. Throws the code of a blocked session.
   * Show the result to the user only: it holds real values.
   */
  restoreText(text: string): string {
    return this.session().vault.restore(text);
  }

  private block(session: Session, error: unknown): void {
    session.scanner.close();
    this.state = { ok: false, code: errorCode(error) };
  }

  private offNotice(): string {
    return `${this.host.name}: off. Raw data may reach the provider and disk. ${HISTORY_NOTE}`;
  }
}

/** A throwing abort must not undo the neutral result that the caller returns. */
function abortSafely(ctx: HostContext): void {
  try {
    ctx.abort();
  } catch {
    // The neutral result holds no raw text, so the run continues without the abort.
  }
}

/** A broken UI must not undo a safe result, such as a cancellation or a withheld message. */
function notifySafely(notify: () => void): void {
  try {
    notify();
  } catch {
    // The safe result is returned even when the notice cannot be shown.
  }
}
