import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  ClassifierContext,
  ClassifierQuestion,
  ImagesContext,
  JsonObject,
  JsonValue,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { MaskError } from "../core/index.ts";

/**
 * Model calls made through the registry, such as codemode's `models.classify()` or
 * another extension's `streamSimple()`, never reach the provider hook. The guard masks
 * their inputs on the registry instance. Image bytes pass through unmasked.
 */
export type GuardedRegistry = Pick<
  ModelRegistry,
  "classify" | "generateImages" | "stream" | "streamSimple" | "complete"
>;

/** Masks one text. Rejecting cancels the call. */
export type MaskText = (text: string) => Promise<string>;

/** Masks one provider payload. Rejecting cancels the request before it is sent. */
type MaskPayload = (payload: unknown) => Promise<unknown>;

type OnPayload = NonNullable<StreamOptions["onPayload"]>;

/**
 * Keyed on the registry through `Symbol.for`, so a reloaded extension finds the
 * guard that an earlier load installed and removes it first.
 */
const INSTALLED = Symbol.for("lmsk.model-guard");

/** `Array.isArray` does not narrow a readonly array out of a union. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * Keys name state fields and answers, so the provider must receive them as written.
 * A key that masking would change blocks the call instead of being renamed.
 */
async function assertUnmaskedKey(key: string, mask: MaskText): Promise<void> {
  if ((await mask(key)) !== key)
    throw new MaskError("BLOCKED", "a classifier key would be masked");
}

async function maskJson(value: JsonValue, mask: MaskText): Promise<JsonValue> {
  if (typeof value === "string") return mask(value);
  if (isJsonArray(value))
    return Promise.all(value.map((item) => maskJson(item, mask)));
  if (value !== null && typeof value === "object")
    return maskObject(value, mask);
  return value;
}

async function maskObject(
  value: JsonObject,
  mask: MaskText,
): Promise<JsonObject> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(
        async ([key, item]): Promise<[string, JsonValue]> => {
          await assertUnmaskedKey(key, mask);
          return [key, await maskJson(item, mask)];
        },
      ),
    ),
  );
}

async function maskValues(
  values: Record<string, string>,
  mask: MaskText,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(
        async ([key, value]): Promise<[string, string]> => {
          await assertUnmaskedKey(key, mask);
          return [key, await mask(value)];
        },
      ),
    ),
  );
}

/** Choice keys stay as the script wrote them, because the answer refers to them. */
async function maskQuestion(
  question: ClassifierQuestion,
  mask: MaskText,
): Promise<ClassifierQuestion> {
  const instructions = await mask(question.instructions);
  switch (question.type) {
    case "choice":
      return {
        ...question,
        instructions,
        criteria: await maskValues(question.criteria, mask),
      };
    case "score":
      return {
        ...question,
        instructions,
        criteria: await Promise.all(
          question.criteria.map((text) => mask(text)),
        ),
      };
    case "bool":
      return {
        ...question,
        instructions,
        criteria: {
          true: await mask(question.criteria.true),
          false: await mask(question.criteria.false),
        },
      };
  }
}

async function maskClassifier(
  context: ClassifierContext,
  mask: MaskText,
): Promise<ClassifierContext> {
  const questions = await Promise.all(
    Object.entries(context.questions).map(
      async ([key, question]): Promise<[string, ClassifierQuestion]> => {
        await assertUnmaskedKey(key, mask);
        return [key, await maskQuestion(question, mask)];
      },
    ),
  );
  return {
    ...context,
    state: await maskObject(context.state, mask),
    questions: Object.fromEntries(questions),
  };
}

async function maskImages(
  context: ImagesContext,
  mask: MaskText,
): Promise<ImagesContext> {
  return {
    ...context,
    input: await Promise.all(
      context.input.map(async (item) =>
        item.type === "text" ? { ...item, text: await mask(item.text) } : item,
      ),
    ),
  };
}

/** `options` with an `onPayload` that runs the caller's first, so that what the caller adds is masked too. */
function masking<O extends { onPayload?: OnPayload } | undefined>(
  options: O,
  mask: MaskPayload,
) {
  const next = options?.onPayload;
  const onPayload: OnPayload = async (payload, model) =>
    mask((await next?.(payload, model)) ?? payload);
  return { ...options, onPayload };
}

/** Wraps the registry's model calls. Reinstalling restores the earlier originals first. */
export function installModelGuard(
  registry: GuardedRegistry,
  mask: MaskText,
  maskPayload: MaskPayload,
): void {
  const uninstall: unknown = Object.getOwnPropertyDescriptor(
    registry,
    INSTALLED,
  )?.value;
  if (typeof uninstall === "function") uninstall();

  const { classify, generateImages, stream, streamSimple, complete } = registry;
  registry.classify = async (model, context, options) =>
    classify.call(
      registry,
      model,
      await maskClassifier(context, mask),
      options,
    );
  registry.generateImages = async (model, context, options) =>
    generateImages.call(
      registry,
      model,
      await maskImages(context, mask),
      options,
    );
  // `bind` keeps the generic signatures of `stream` and `complete`, which `call` erases.
  registry.stream = (model, context, options) =>
    stream.bind(registry)(model, context, masking(options, maskPayload));
  registry.streamSimple = (model, context, options) =>
    streamSimple.bind(registry)(model, context, masking(options, maskPayload));
  registry.complete = (model, context, options) =>
    complete.bind(registry)(model, context, masking(options, maskPayload));
  Object.defineProperty(registry, INSTALLED, {
    configurable: true,
    value: () => {
      Object.assign(registry, {
        classify,
        generateImages,
        stream,
        streamSimple,
        complete,
      });
    },
  });
}
