import { AsyncGuardError, UnknownGuardError, isThenable } from "../fsm/evaluator.js";
import type { Guard, GuardArgs, GuardRef } from "../fsm/types.js";

function resolveItem<Ctx, Evt>(item: GuardRef<Ctx, Evt>, args: GuardArgs<Ctx, Evt>): boolean {
  const fn = typeof item === "function" ? item : args.guards?.[item];
  if (!fn) throw new UnknownGuardError(item as string);
  const result = fn(args);
  // Mirror evalGuard's safety net: a guard that returns a thenable breaks
  // determinism. Checked here too so a thenable nested inside and/or/not is
  // rejected rather than coerced truthy by the combinator (FSM-S-01).
  if (isThenable(result)) {
    // Function.prototype.name is "" for anonymous arrows — fall back to
    // "<inline>" so the message stays readable (matches evalGuard).
    throw new AsyncGuardError(typeof item === "string" ? item : fn.name || "<inline>");
  }
  return result;
}

/** Logical AND over guards. Short-circuits on the first `false`. */
export function and<Ctx, Evt>(items: readonly GuardRef<Ctx, Evt>[]): Guard<Ctx, Evt> {
  return (args) => {
    for (const item of items) {
      if (!resolveItem(item, args)) return false;
    }
    return true;
  };
}

/** Logical OR over guards. Short-circuits on the first `true`. */
export function or<Ctx, Evt>(items: readonly GuardRef<Ctx, Evt>[]): Guard<Ctx, Evt> {
  return (args) => {
    for (const item of items) {
      if (resolveItem(item, args)) return true;
    }
    return false;
  };
}

/** Logical NOT. */
export function not<Ctx, Evt>(item: GuardRef<Ctx, Evt>): Guard<Ctx, Evt> {
  return (args) => !resolveItem(item, args);
}

/**
 * Predicate that passes when the current state value is one of the listed
 * states. Reads `args.value`, which `evalGuard` threads from the live
 * snapshot. When called outside of `evalGuard` (e.g. unit tests), `value` is
 * `undefined` and the guard returns `false`.
 */
export function stateIn<Ctx, Evt>(...states: readonly string[]): Guard<Ctx, Evt> {
  const set = new Set<string>(states);
  return ({ value }) => typeof value === "string" && set.has(value);
}
