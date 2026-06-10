import { isThenable } from "../fsm/evaluator.js";
import type { Effect, EffectHandler } from "../fsm/types.js";

// Lazily-built never-aborting signal for callers who don't supply one. Reused
// across runEffects() invocations to avoid allocating a controller per call.
let NEVER_SIGNAL: AbortSignal | undefined;
function neverSignal(): AbortSignal {
  if (!NEVER_SIGNAL) NEVER_SIGNAL = new AbortController().signal;
  return NEVER_SIGNAL;
}

/**
 * Dispatch a batch of effects through the supplied handler map. Effects whose
 * `type` has no handler are silently skipped (the runtime treats unhandled
 * effects as informational).
 *
 * Returns the array of Promise results (if any handler is async) so callers
 * can `await Promise.all(...)` when they need flushing — the default runtime
 * is fire-and-forget and discards them.
 *
 * Each handler receives an `AbortSignal`. When called from `createRuntime`,
 * the signal is the runtime's own controller. Stand-alone callers may omit
 * `args.signal` (a never-aborting placeholder is supplied) or pass their own
 * (e.g. `AbortSignal.timeout(5000)`, `AbortSignal.any([...])`).
 */
export function runEffects<Ctx, Evt>(
  effects: readonly Effect[],
  handlers: Readonly<Record<string, EffectHandler<Ctx, Evt>>> | undefined,
  args: { context: Ctx; event: Evt; signal?: AbortSignal },
): readonly Promise<void>[] {
  if (!handlers || effects.length === 0) return [];
  const signal = args.signal ?? neverSignal();
  const handlerArgs = { context: args.context, event: args.event, signal };
  const promises: Promise<void>[] = [];
  for (const eff of effects) {
    const h = handlers[eff.type];
    if (!h) continue;
    const r = h(eff, handlerArgs);
    // isThenable (not instanceof Promise) so cross-realm Promises and
    // user-defined PromiseLike results are also awaitable by callers;
    // Promise.resolve() normalises them to a real Promise (FSM-B-03).
    if (isThenable(r)) promises.push(Promise.resolve(r));
  }
  return promises;
}
