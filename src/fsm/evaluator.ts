import type { Guard, GuardRef, Implementations } from "./types.js";

export class UnknownGuardError extends Error {
  readonly guardName: string;
  constructor(guardName: string) {
    super(`aifsmjs: guard "${guardName}" not found in implementations.guards`);
    this.name = "UnknownGuardError";
    this.guardName = guardName;
  }
}

export class AsyncGuardError extends Error {
  readonly guardName: string;
  constructor(guardName: string) {
    super(
      `aifsmjs: guard "${guardName}" must be sync; received a Promise. Async guards break determinism and replay. Move I/O into an effect.`,
    );
    this.name = "AsyncGuardError";
    this.guardName = guardName;
  }
}

/**
 * Detect declared-async guards at definition time. Catches the common case of
 * `async (args) => ...` inline guards. Combinator builders or arrow returns of
 * a Promise still slip past — those are caught at `evalGuard` runtime via
 * the `isThenable` check.
 *
 * Caveat: this relies on `Function.prototype.constructor.name === "AsyncFunction"`,
 * which is reliable in ES2017+ runtimes. If your bundler transpiles `async`
 * to generator-based code (e.g. ES5 / very old TypeScript targets), this
 * check returns `false` for those forms — the runtime `evalGuard` thenable
 * check still catches them.
 */
export function isAsyncGuardFn(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  return fn.constructor?.name === "AsyncFunction";
}

/**
 * Detect a thenable (PromiseLike) — anything with a callable `then`. Used in
 * place of `instanceof Promise` so cross-realm Promises (iframe / worker /
 * vm context) and user-defined thenables are also rejected.
 *
 * Exported for the guard combinators (`and`/`or`/`not`), which must apply the
 * same async-guard rejection to the values their inner guards return —
 * otherwise a nested thenable is coerced truthy inside the combinator and the
 * top-level `evalGuard` check never sees it (FSM-S-01).
 */
export function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (
    x !== null &&
    (typeof x === "object" || typeof x === "function") &&
    typeof (x as { then?: unknown }).then === "function"
  );
}

/**
 * Resolve a guard ref to a Guard function. String refs are looked up in the
 * implementations map; inline functions are returned as-is.
 */
export function resolveGuard<Ctx, Evt>(
  ref: GuardRef<Ctx, Evt>,
  impl: Implementations<Ctx, Evt>,
): Guard<Ctx, Evt> {
  if (typeof ref === "function") return ref;
  const fn = impl.guards?.[ref];
  if (!fn) throw new UnknownGuardError(ref);
  return fn;
}

/**
 * Evaluate a guard ref against (context, event). Guards must be sync and pure;
 * TypeScript blocks declared-async signatures at compile time, but JS callers
 * or casts can still slip through. This function checks two ways:
 *   1. Inline AsyncFunction (declared `async`) → throw AsyncGuardError.
 *   2. Return value is a Promise → throw AsyncGuardError.
 * Both throws are user errors; they would otherwise silently pass the guard
 * (Promise is truthy) and break determinism.
 *
 * The optional `value` argument is the current state value, threaded so the
 * `stateIn` combinator and similar predicates can introspect it.
 */
export function evalGuard<Ctx, Evt>(
  ref: GuardRef<Ctx, Evt>,
  context: Ctx,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
  value?: string,
): boolean {
  const fn = resolveGuard(ref, impl);
  // Function.prototype.name is "" for anonymous arrows — use `||` not `??`
  // so the empty string falls back to "<inline>" for readable error messages.
  const guardName = typeof ref === "string" ? ref : fn.name || "<inline>";
  if (isAsyncGuardFn(fn)) {
    throw new AsyncGuardError(guardName);
  }
  // Build args while honouring exactOptionalPropertyTypes: omit fields that
  // would otherwise be assigned `undefined`.
  type Args = {
    context: Ctx;
    event: Evt;
    guards?: Readonly<Record<string, Guard<Ctx, Evt>>>;
    value?: string;
  };
  const args: Args = { context, event };
  const guardsMap = impl.guards;
  if (guardsMap) args.guards = guardsMap;
  if (value !== undefined) args.value = value;
  const result = fn(args);
  // TS narrows `result` to boolean from Guard's return type, but a JS caller
  // or a cast can slip a Promise / PromiseLike through. We accept anything
  // thenable (native Promise, cross-realm Promise, user-defined thenable),
  // not just same-realm `instanceof Promise`.
  if (isThenable(result)) {
    throw new AsyncGuardError(guardName);
  }
  return result;
}
