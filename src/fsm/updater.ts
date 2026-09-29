import { InvalidActionResultError } from "./lifecycle.js";
import { isPlainObject } from "./snapshot.js";
import type { Action } from "./types.js";

/**
 * Build an Action that returns a Partial<Ctx> from a pure updater.
 * The partial is merged into the current context by `step()`.
 */
export function assign<Ctx, Evt>(
  updater: (args: { context: Ctx; event: Evt }) => Partial<Ctx>,
): Action<Ctx, Evt> {
  return ({ context, event }) => updater({ context, event });
}

/**
 * Merge an action's result into the current context. The function never
 * mutates either argument.
 *
 * - `undefined` / `null` patch: `current` is returned unchanged.
 * - Object context (not an array or `ArrayBuffer` view) + plain-object patch:
 *   shallow merge into a new object that keeps `current`'s prototype, so a
 *   class-instance context keeps its methods and untouched fields. Only own
 *   enumerable (string and symbol) properties are carried; `#private` and
 *   non-enumerable members are not, so prefer plain-object contexts.
 * - Object context + non-nullish primitive patch (`false`, `0`, `""`, ...):
 *   throws {@link InvalidActionResultError} (`actionName` names the action).
 * - Anything else (a primitive or array context, or a non-plain-object patch
 *   such as an array or class instance): the patch replaces `current`.
 */
export function mergeContext<Ctx>(
  current: Ctx,
  patch: Partial<Ctx> | void,
  actionName = "<inline>",
): Ctx {
  if (patch === undefined || patch === null) return current;
  if (
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    !ArrayBuffer.isView(current)
  ) {
    // Spread (CreateDataProperty) rather than Object.assign ([[Set]]): an own
    // `__proto__` key in a JSON-derived patch stays a plain data property
    // instead of re-prototyping the merged context, and prototype setters
    // are never invoked. Object.setPrototypeOf is a no-op for plain contexts.
    if (isPlainObject(patch)) {
      return Object.setPrototypeOf({ ...current, ...patch }, Object.getPrototypeOf(current));
    }
    if (typeof patch !== "object" && typeof patch !== "function") {
      throw new InvalidActionResultError(actionName, patch);
    }
  }
  return patch as Ctx;
}
