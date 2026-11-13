import {
  DEFAULT_SETTINGS,
  type HostDefaults,
  isRecord,
  loadConfig,
  type MaskConfig,
  type Rule,
} from "./config.ts";
import { CodedError, errorCode } from "./errors.ts";
import { MachineVault } from "./machine-vault.ts";
import { Masker } from "./masker.ts";
import { mapPayload, type PayloadFormat, textsOf } from "./payload.ts";
import { type ShownFakes, TextRestorer } from "./restorer.ts";
import { Scanner } from "./scanner.ts";
import {
  isNetworkCommand,
  protectedPath,
  searchedPath,
} from "./tool-policy.ts";

export type NoticeLevel = "info" | "warning" | "error";

/** The part of a host event context that the guard uses. */
export interface HostContext {
  ui: { notify(message: string, level: NoticeLevel): void };
  /** Stops the host's current operation, so that no request of it reaches the provider. */
  abort(): void;
}

/** What the host supplies once. */
export interface GuardHost extends Omit<HostDefaults, "rules"> {
  /** Starts every notice. */
  name: string;
  /** The provider fields that masking keeps byte-exact. */
  format: PayloadFormat;
}

export interface OpenOptions {
  /** Global configuration files, in merge order. */
  configPaths: readonly string[];
  /** The project configuration file. Pass it only when the project is trusted. */
  projectConfigPath: string | undefined;
  /** The private directory of the machine vault. */
  stateDir: string;
  /** The environment of the agent's processes. An `env` rule learns its values from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** Rules that the host adds under the configuration, such as `localIdentityRules()`. */
  defaultRules: readonly Rule[];
}

export const HIDDEN =
  "lmsk: withheld. This text holds a secret spaced out, wrapped, reversed or encoded.";

/** Every string of a payload, also the call ids that masking keeps byte-exact. Bytes stay bytes. */
const EVERY_TEXT: PayloadFormat = {
  opaque: (_key, value) => value instanceof Uint8Array,
};

/** A tool call as the host received it. */
export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The host checked that the tool is its own, not a plugin tool of the same name. */
  verified: boolean;
  /** The input field that holds a shell command. */
  commandKey?: string;
  cwd: string;
  /** The paths, or command words that may be paths, that the tool opens with `input`. */
  targets(input: Record<string, unknown>): string[];
  /** The folders that the tool searches with `input`. */
  roots(input: Record<string, unknown>): string[];
}

/** `off` lasts until the guard opens again. */
export type Redaction = "enabled" | "off";

interface Opened {
  config: MaskConfig;
  scanner: Scanner;
  masker: Masker;
  store: MachineVault;
}

type State = { ok: true; opened: Opened } | { ok: false; code: string };

function openState(options: OpenOptions, host: GuardHost): State {
  const loaded = loadConfig(options.configPaths, options.projectConfigPath, {
    ...host,
    rules: options.defaultRules,
  });
  if (loaded.problems.length > 0) return { ok: false, code: "CONFIG_INVALID" };
  const store = MachineVault.open(options.stateDir);
  const scanner = new Scanner(loaded.config.scanTimeoutMs);
  try {
    const masker = new Masker(
      loaded.config.rules,
      scanner,
      store.vault,
      options.env,
      host.format,
    );
    return {
      ok: true,
      opened: { config: loaded.config, scanner, masker, store },
    };
  } catch (error) {
    scanner.close();
    throw error;
  }
}

/**
 * The host-independent state of one agent process: masks run one at a time over the machine vault,
 * a failed open blocks masking until the next open, and notices explain each stop. Masking happens on
 * the wire only: the host keeps real values, and each request is masked whole.
 */
export class Guard {
  private readonly host: GuardHost;
  private state: State = { ok: false, code: "NOT_STARTED" };
  private redaction: Redaction = "enabled";
  private reportedStop = false;
  private reportedBlock = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(host: GuardHost) {
    this.host = host;
  }

  /** Closes the earlier state and opens a new one. A failure, also a throw of `options`, blocks masking until the next open. */
  open(options: () => OpenOptions, ctx: HostContext): void {
    if (this.state.ok) this.state.opened.scanner.close();
    try {
      this.state = openState(options(), this.host);
    } catch (error) {
      this.state = { ok: false, code: errorCode(error) };
    }
    this.redaction = "enabled";
    this.reportedStop = false;
    this.reportedBlock = false;
    if (!this.state.ok) this.report(ctx, this.state.code);
  }

  /** Stops the scanner worker so the process can exit. The closed state keeps a later scan from restarting it. */
  close(): void {
    if (this.state.ok) this.state.opened.scanner.close();
    this.state = { ok: false, code: "SESSION_SHUTDOWN" };
  }

  /** Whether the user turned masking off in a working guard. */
  get off(): boolean {
    return this.state.ok && this.redaction === "off";
  }

  /**
   * Restores the fakes in a verified call's input, in place, and saves the reals put back, so that
   * every later request that holds the call's id masks them, also when they are too short to learn.
   * A call whose restored path is protected keeps its fakes and is blocked: the check runs after the
   * restore, so a fake path cannot restore into a protected one. A failed save throws, and the input
   * keeps its fakes.
   */
  restoreCall(call: ToolCall): { blocked: boolean } {
    const reals = new Set<string>();
    const input = call.verified
      ? this.restoreInput(call.tool, call.input, call.commandKey, reals)
      : call.input;
    if (this.isProtected(call.targets(input), call.roots(input), call.cwd))
      return { blocked: true };
    if (this.state.ok) this.state.opened.store.recordCall(call.id, [...reals]);
    Object.assign(call.input, input);
    return { blocked: false };
  }

  /** A blocked guard keeps the default paths and the host's own files protected. */
  private isProtected(
    paths: readonly string[],
    roots: readonly string[],
    cwd: string,
  ): boolean {
    const patterns = this.state.ok
      ? this.state.opened.config.protectedPaths
      : [...DEFAULT_SETTINGS.protectedPaths, ...this.host.protectedPaths];
    return (
      protectedPath(paths, cwd, patterns) !== undefined ||
      searchedPath(roots, cwd, patterns) !== undefined
    );
  }

  /**
   * A copy of the `input` of a call to `tool` with its fakes restored, and the reals put back in
   * `reals`. When `input[commandKey]` is a command that sends to the network after restore, the
   * input keeps its fakes.
   */
  private restoreInput(
    tool: string,
    input: Record<string, unknown>,
    commandKey: string | undefined,
    reals: Set<string>,
  ): Record<string, unknown> {
    if (!this.state.ok) return input;
    const { config, masker } = this.state.opened;
    if (!config.restoredTools.includes(tool)) return input;
    const restored = masker.restoreValue(input, reals);
    if (isRecord(restored)) {
      // After restore, so a masked client name, such as `curl`, is seen too.
      const command =
        commandKey === undefined ? undefined : restored[commandKey];
      if (typeof command !== "string" || !isNetworkCommand(command, config))
        return restored;
    }
    reals.clear();
    return input;
  }

  /** Runs `run` when the guard is open. A blocked guard or a throw returns `fail` with its code. */
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
   * Runs masks one at a time, each after the vault reads what other processes added, so that no
   * other mask of this process changes the vault during it. A mask fails when the guard is blocked
   * or opened again during it.
   */
  private exclusive<T>(opened: Opened, mask: () => Promise<T>): Promise<T> {
    const current = (): boolean =>
      this.state.ok && this.state.opened === opened;
    const run = this.queue.then(async () => {
      if (!current()) throw new CodedError("SESSION_CHANGED");
      opened.store.vault.refresh();
      // A replaced state's closed scanner fails its late mask; that failure belongs to no live state.
      const masked = await mask().catch((error: unknown) => {
        throw current() ? error : new CodedError("SESSION_CHANGED");
      });
      if (!current()) throw new CodedError("SESSION_CHANGED");
      return masked;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The open state. Throws the block code when the guard is blocked. */
  private opened(): Opened {
    if (!this.state.ok) throw new CodedError(this.state.code);
    return this.state.opened;
  }

  /**
   * Masks a provider payload, and returns it unchanged while masking is off. Rejects when the guard is
   * blocked, and with HIDDEN_REAL when a text still holds a real plainly. The reals that `restoreCall`
   * put back into a call whose id the payload or `callIds` holds are masked everywhere in it: a host
   * gives the ids that its payloads change or leave out. A text that hides a real in another reading
   * becomes HIDDEN, as `withholdHiddenCopies` asks.
   */
  readonly maskPayload = async (
    payload: unknown,
    callIds: readonly string[] = [],
  ): Promise<unknown> => this.maskPayloadIn(this.opened(), payload, callIds);

  /**
   * A payload masker and the fakes to show, bound to the open state, for work that outlives one event,
   * such as a summary. Throws when the guard is blocked. Its masks reject with SESSION_CHANGED once the
   * guard opens again.
   */
  payloadMasker(callIds: readonly string[] = []): ShownFakes & {
    maskPayload(payload: unknown): Promise<unknown>;
  } {
    const opened = this.opened();
    return {
      maskPayload: (payload) => this.maskPayloadIn(opened, payload, callIds),
      shownSpans: (text, from) => opened.masker.shownSpans(text, from),
      longestFake: () => opened.masker.longestFake(),
    };
  }

  private async maskPayloadIn(
    opened: Opened,
    payload: unknown,
    callIds: readonly string[],
  ): Promise<unknown> {
    if (!this.state.ok || this.state.opened !== opened)
      throw new CodedError("SESSION_CHANGED");
    if (this.off) return payload;
    return this.exclusive(opened, async () => {
      const { config, masker, store } = opened;
      const ids = textsOf(payload, (value, map) =>
        mapPayload(value, map, EVERY_TEXT),
      );
      const masked = await masker.maskPayload(
        payload,
        store.realsOf([...ids, ...callIds]),
      );
      const texts = masker.payloadTexts(masked);
      await masker.assertNoHiddenRealInPayload(texts);
      if (!config.withholdHiddenCopies) return masked;
      const hiding = await masker.hidingTexts(texts);
      return mapPayload(
        masked,
        (text) => (hiding.has(text) ? HIDDEN : text),
        this.host.format,
      );
    });
  }

  /**
   * Masks `texts` and returns them in input order, and unchanged while masking is off.
   * Rejects when the guard is blocked, and with HIDDEN_REAL when a text still holds a real plainly.
   * A text that hides a real in another reading becomes HIDDEN, as `withholdHiddenCopies` asks.
   * The reals that `restoreCall` put back into a call whose id `callIds` holds are masked everywhere.
   */
  async maskTexts(
    texts: string[],
    callIds: readonly string[] = [],
  ): Promise<string[]> {
    const opened = this.opened();
    if (this.off) return texts;
    return this.exclusive(opened, async () => {
      const masked = await opened.masker.mask(
        texts,
        opened.store.realsOf(callIds),
      );
      await opened.masker.assertNoHiddenReal(masked, false);
      if (!opened.config.withholdHiddenCopies) return masked;
      const hiding = await opened.masker.hidingTexts(masked);
      return masked.map((text) => (hiding.has(text) ? HIDDEN : text));
    });
  }

  /** `maskTexts` for one text, such as a model call input. */
  readonly maskText = async (text: string): Promise<string> => {
    const [masked] = await this.maskTexts([text]);
    return masked;
  };

  /**
   * Restores model output that arrives in pieces for the user: only the fakes whose real any later
   * mask turns back into the same fake. Throws the code of a blocked guard.
   */
  textRestorer(): TextRestorer {
    return new TextRestorer(this.opened().masker);
  }

  /**
   * Shows one notice per open for a stopped request and one for a blocked guard, so that
   * neither repeats on each request and a stopped request does not hide a later block.
   */
  readonly report = (ctx: HostContext, code: string): void => {
    // A replaced state's late mask must not use up the notice of the new state.
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

  /** The abort keeps the text that masking refused from reaching a provider request of the current operation. */
  failClosed(
    ctx: HostContext,
    code: string,
    notify: (ctx: HostContext, code: string) => void,
  ): void {
    abortSafely(ctx);
    notifySafely(() => notify(ctx, code));
  }

  /** The masking state for the user: enabled, off or blocked with its code. */
  status(): string {
    if (!this.state.ok)
      return `${this.host.name}: blocked (${this.state.code}). Requests that need masking are blocked until the session reloads.`;
    return this.redaction === "off" ? this.offNotice() : this.onNotice();
  }

  /** Turns masking on or off and returns the notice for the user. Throws the code of a blocked guard: only a new open clears a block. */
  setRedaction(next: Redaction): string {
    this.opened();
    this.redaction = next;
    return next === "off" ? this.offNotice() : this.onNotice();
  }

  /**
   * The text with the real value in place of each known fake. Throws the code of a blocked guard.
   * Show the result to the user only: it holds real values.
   */
  restoreText(text: string): string {
    const { vault } = this.opened().store;
    vault.refresh();
    return vault.restore(text);
  }

  private onNotice(): string {
    return `${this.host.name}: enabled. The provider gets fakes, you see real values.`;
  }

  private offNotice(): string {
    return `${this.host.name}: off. The provider gets real values.`;
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

/** A broken UI must not undo a safe result, such as a cancellation or a blocked request. */
function notifySafely(notify: () => void): void {
  try {
    notify();
  } catch {
    // The safe result is returned even when the notice cannot be shown.
  }
}
