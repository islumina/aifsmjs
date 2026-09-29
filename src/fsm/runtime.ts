import { InvalidDefinitionError, assertObject, initialSnapshot } from "./definition.js";
import { isThenable, ownValue } from "./evaluator.js";
import { chooseTransition, stepWithMeta } from "./lifecycle.js";
import { IS_DEV, deepFreeze } from "./snapshot.js";
import {
  type Effect,
  type Implementations,
  type MachineDef,
  type Middleware,
  RESET_EVENT_TYPE,
  type ResetEvent,
  type Runtime,
  type RuntimeEventMap,
  type RuntimeOptions,
  type RuntimeTransitionEvent,
  type Snapshot,
} from "./types.js";

export class RuntimeDisposedError extends Error {
  constructor() {
    super("aifsmjs: runtime has been disposed; send()/reset() are not allowed");
    this.name = "RuntimeDisposedError";
  }
}

/**
 * Thrown by `send()` / `reset()` when a sub-machine init or dispose throws.
 *
 * Prepare-then-commit: the new child is constructed before the previous one
 * is disposed. Invariants:
 * - `phase: "init"` — the new child's constructor threw. The parent snapshot
 *   is not committed and the previous child (if any) is untouched: still live
 *   and still returned by `subRuntime()`. No middleware ran, no `'transition'`
 *   was emitted, no effects were dispatched.
 * - `phase: "dispose"` — the previous child's `dispose()` threw. The new
 *   child (if any) was discarded, the parent snapshot is not committed, and
 *   `subRuntime()` returns `undefined` until the sub state is re-entered.
 * - Never thrown from `runtime.dispose()` cascade (never-throws contract).
 *
 * @since 0.3.0
 */
export class SubMachineError extends Error {
  readonly parentState: string;
  readonly phase: "init" | "dispose";
  override readonly cause: unknown;

  constructor(parentState: string, phase: "init" | "dispose", cause: unknown) {
    super(`aifsmjs: sub-machine ${phase} failed at parent state "${parentState}"`, { cause });
    this.name = "SubMachineError";
    this.parentState = parentState;
    this.phase = phase;
    this.cause = cause; // belt-and-suspenders: legacy bundlers ignore ES2022 cause option
  }
}

const RESET_EVENT: ResetEvent = Object.freeze({ type: RESET_EVENT_TYPE });

function composeMiddleware<Ctx, Evt, States extends string>(
  middleware: readonly Middleware<Ctx, Evt, States>[],
): Middleware<Ctx, Evt, States> {
  return (ctx, finalNext) => {
    let index = -1;
    const dispatch = (i: number): void => {
      if (i <= index) throw new Error("aifsmjs: next() called multiple times in middleware");
      index = i;
      const fn = middleware[i];
      if (!fn) {
        finalNext();
        return;
      }
      fn(ctx, () => dispatch(i + 1));
    };
    dispatch(0);
  };
}

type Queued<Evt> = { kind: "send"; event: Evt } | { kind: "reset"; event?: Evt | undefined };

function assertListener(listener: unknown): void {
  if (typeof listener !== "function") {
    throw new InvalidDefinitionError("listener must be a function");
  }
}

/**
 * Build a thin stateful runtime around a machine. `send()` calls `step()`,
 * commits, runs the read-only middleware pipeline, dispatches effects, and
 * notifies subscribers then `'transition'` listeners. `send()`/`reset()` are
 * run-to-completion: a call made while the runtime is already dispatching
 * (from middleware, an effect handler, a listener, or a child runtime) is
 * queued FIFO and processed after the current event's last notification.
 * The runtime owns an `AbortController`; `dispose()` aborts it and clears all
 * state.
 *
 * Arguments are validated before anything is created: a non-object `def`,
 * `def.states`, `impl` or `opts`, or a `middleware` option that is not an
 * array of functions, throws `InvalidDefinitionError`. The rest of `def` is
 * trusted (build it with `defineMachine` / `setup().defineMachine`).
 */
export function createRuntime<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  opts: RuntimeOptions<Ctx, Evt, States> = {},
): Runtime<Ctx, Evt, States> {
  assertObject(def, "definition");
  assertObject(def.states, "definition states");
  assertObject(impl, "implementations");
  assertObject(opts, "options");
  const middleware = opts.middleware;
  if (
    middleware !== undefined &&
    !(Array.isArray(middleware) && middleware.every((fn) => typeof fn === "function"))
  ) {
    throw new InvalidDefinitionError("options.middleware must be an array of functions");
  }
  let snapshot: Snapshot<Ctx, States> = initialSnapshot(def);
  const listeners = new Set<(snap: Snapshot<Ctx, States>) => void>();
  const middlewareChain =
    middleware && middleware.length > 0 ? composeMiddleware(middleware) : undefined;
  const shouldDispatch = opts.dispatchEffects !== false;
  const controller = new AbortController();
  let disposed = false;
  // Run-to-completion (ai*js state-owning dispatcher rule): while one event is
  // being processed, nested send()/reset() calls land in this FIFO mailbox.
  let dispatching = false;
  const mailbox: Queued<Evt>[] = [];
  // §3.1 The live child of the current state's `sub`, if any. Replaced only by
  // swapChild(); cleared by dispose().
  let childRuntime: Runtime<unknown, { type: string }, string> | undefined;

  type EventListeners = {
    [K in keyof RuntimeEventMap<Ctx, Evt, States>]: Set<
      (payload: RuntimeEventMap<Ctx, Evt, States>[K]) => void
    >;
  };
  const eventListeners: EventListeners = {
    transition: new Set(),
    error: new Set(),
    dispose: new Set(),
  };
  const externalAbortCleanups = new Set<() => void>();

  function emit<K extends keyof RuntimeEventMap<Ctx, Evt, States>>(
    type: K,
    payload: RuntimeEventMap<Ctx, Evt, States>[K],
  ): void {
    // Snapshot-before-iterate (ai*js fan-out rule): a listener added during
    // dispatch first fires on the next event, and one removed meanwhile
    // (unsubscribe, `once`, signal abort, dispose) is skipped for the rest of
    // this dispatch. Per-listener isolation: a throwing listener must not skip
    // the ones after it (a 'dispose' cleanup hook would leak). The first error
    // is rethrown once every listener has run, so it still surfaces.
    const set = eventListeners[type];
    let failed = false;
    let firstError: unknown;
    for (const fn of Array.from(set)) {
      if (!set.has(fn)) continue;
      try {
        fn(payload);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
    if (failed) throw firstError;
  }

  function dispatchEffects(effects: readonly Effect[], context: Ctx, event: Evt): void {
    if (!impl.effects || effects.length === 0) return;
    for (const eff of effects) {
      const handler = ownValue(impl.effects, eff.type);
      if (!handler) continue;
      const r = handler(eff, { context, event, signal: controller.signal });
      // isThenable (not instanceof Promise) so cross-realm Promises and
      // user-defined PromiseLike results also have their rejections routed to
      // the 'error' channel; Promise.resolve() normalises them (FSM-B-03).
      if (isThenable(r)) {
        Promise.resolve(r).catch((err: unknown) => {
          // Never re-thrown: an unhandledRejection would crash Node >= 15 and
          // break fire-and-forget. With no 'error' listener (none registered,
          // or cleared by dispose()) it is discarded, with a dev-only warning.
          if (eventListeners.error.size > 0) emit("error", { error: err, event });
          else if (IS_DEV) {
            console.warn(
              'aifsmjs: unhandled async effect rejection; register runtime.on("error", ...)',
              err,
            );
          }
        });
      }
    }
  }

  // §3.1 Prepare-then-commit child swap for a move from `prevValue` into
  // `nextValue` (transitions, reset() and bootstrap). Throws SubMachineError;
  // the caller must NOT commit the parent snapshot on throw.
  //   1. Construct the new child first: an init failure leaves the old child
  //      live and untouched.
  //   2. Dispose the old child: a failure discards the new child.
  //   3. Adopt the new child — or discard it when a listener run by step 2
  //      disposed this runtime meanwhile.
  function swapChild(prevValue: States, nextValue: States): void {
    const stateDef = def.states[nextValue];
    let next: Runtime<unknown, { type: string }, string> | undefined;
    if (stateDef?.sub) {
      try {
        next = createRuntime(stateDef.sub, stateDef.subImpl ?? {});
      } catch (cause) {
        throw new SubMachineError(nextValue, "init", cause);
      }
    }
    const old = childRuntime;
    if (old) {
      childRuntime = undefined;
      try {
        old.dispose();
      } catch (cause) {
        next?.dispose(); // a freshly built runtime's dispose() never throws
        throw new SubMachineError(prevValue, "dispose", cause);
      }
    }
    if (disposed) next?.dispose();
    else childRuntime = next;
  }

  // Commit, then middleware -> effects -> subscribers -> 'transition'.
  function commit(
    prev: Snapshot<Ctx, States>,
    next: Snapshot<Ctx, States>,
    event: Evt | ResetEvent,
    effects: readonly Effect[],
    changed: boolean,
  ): void {
    snapshot = next;
    // Middleware gets the caller's event by reference, never frozen (the
    // caller owns it). The wrapper is frozen, prev/next are already frozen to
    // the NODE_ENV depth (STABILITY.md), and effects are deep-frozen so no
    // middleware can alter a payload before dispatch.
    middlewareChain?.(
      Object.freeze({ prev, next, event, effects: deepFreeze(effects), changed }),
      () => {},
    );
    // reset() commits no effects, so its sentinel event never reaches a handler.
    if (shouldDispatch) dispatchEffects(effects, next.context, event as Evt);
    if (changed) {
      // Same snapshot-before-iterate / skip-removed rule as emit().
      for (const l of Array.from(listeners)) if (listeners.has(l)) l(next);
      emit("transition", {
        prev,
        next,
        event,
        effects,
        changed: true,
      } as RuntimeTransitionEvent<Ctx, Evt, States>);
    }
  }

  function processSend(event: Evt): void {
    const prev = snapshot;
    const { result, external } = stepWithMeta(def, prev, event, impl);
    // Sub lifecycle BEFORE snapshot commit (§3.4), decided from the same guard
    // pass as the snapshot; throws SubMachineError on failure → no commit.
    if (result.changed && (prev.value !== result.snapshot.value || external)) {
      swapChild(prev.value, result.snapshot.value);
    }
    commit(prev, result.snapshot, event, result.effects, result.changed);
  }

  function processReset(event: Evt | undefined): void {
    const prev = snapshot;
    const next = initialSnapshot(def);
    // reset() is re-birth: the current child is always replaced (§3.5).
    swapChild(prev.value, next.value);
    commit(
      prev,
      next,
      event ?? RESET_EVENT,
      [],
      prev.value !== next.value || prev.status !== next.status || prev.context !== next.context,
    );
  }

  function run(entry: Queued<Evt>): Snapshot<Ctx, States> {
    if (disposed) throw new RuntimeDisposedError();
    if (
      (entry.kind === "send" || entry.event !== undefined) &&
      typeof entry.event?.type !== "string"
    ) {
      throw new InvalidDefinitionError(
        `${entry.kind}() event must be an object with a string type`,
      );
    }
    if (dispatching) {
      // Nested call: queue it and hand back what is committed right now.
      mailbox.push(entry);
      return snapshot;
    }
    dispatching = true;
    try {
      // dispose() empties the mailbox, so the drain stops there too.
      for (let m: Queued<Evt> | undefined = entry; m && !disposed; m = mailbox.shift()) {
        if (m.kind === "send") processSend(m.event);
        else processReset(m.event);
      }
    } finally {
      // A throw discards whatever is still queued; the error propagates from
      // this (outermost) call and the snapshot stays at the last commit.
      dispatching = false;
      mailbox.length = 0;
    }
    return snapshot;
  }

  function on<K extends keyof RuntimeEventMap<Ctx, Evt, States>>(
    type: K,
    listener: (payload: RuntimeEventMap<Ctx, Evt, States>[K]) => void,
    options?: { signal?: AbortSignal; once?: boolean },
  ): () => void {
    if (!Object.hasOwn(eventListeners, type)) {
      throw new InvalidDefinitionError('on() type must be "transition", "error" or "dispose"');
    }
    assertListener(listener);
    if (disposed || options?.signal?.aborted) return () => {};
    const target = eventListeners[type];
    let detachAbort: (() => void) | undefined;
    // Full teardown shared by the once-wrapper, the abort handler, and the
    // returned unsubscribe so every path detaches the abort listener too — a
    // once-handler that also passed a { signal } previously left the abort
    // listener attached until dispose()/abort (memory leak).
    const cleanup = (): void => {
      target.delete(wrapped);
      if (detachAbort) {
        detachAbort();
        externalAbortCleanups.delete(detachAbort);
      }
    };
    let wrapped: (payload: RuntimeEventMap<Ctx, Evt, States>[K]) => void = listener;
    if (options?.once) {
      // Inert before its first call: removed first, then invoked.
      wrapped = (payload) => {
        cleanup();
        listener(payload);
      };
    }
    target.add(wrapped);
    const signal = options?.signal;
    if (signal) {
      const onAbort = () => cleanup();
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", onAbort);
      externalAbortCleanups.add(detachAbort);
    }
    return cleanup;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Never queued: runs at once, even mid-dispatch, and drops queued events.
    mailbox.length = 0;
    // Cascade child dispose; swallow exceptions (dispose contract) (§3.6)
    const child = childRuntime;
    childRuntime = undefined;
    try {
      child?.dispose();
    } catch {
      /* swallow */
    }
    controller.abort();
    listeners.clear();
    // §3.6 dispose() is contractually never-throws + idempotent (README,
    // STABILITY.md). emit('dispose') runs user listeners; a throwing one
    // must neither escape dispose() nor abort the remaining teardown (which
    // would leak external-signal abort listeners, since a second dispose()
    // short-circuits on `if (disposed) return`). The try/finally guarantees
    // the listener-set clear + externalAbortCleanups loop ALWAYS run.
    try {
      emit("dispose", undefined as RuntimeEventMap<Ctx, Evt, States>["dispose"]);
    } catch {
      /* swallow — never-throws contract */
    } finally {
      for (const set of Object.values(eventListeners)) set.clear();
      for (const cleanup of externalAbortCleanups) cleanup();
      externalAbortCleanups.clear();
    }
  }

  const runtime: Runtime<Ctx, Evt, States> = {
    getSnapshot: () => snapshot,
    snapshot: () => snapshot,
    send: (event) => run({ kind: "send", event }),
    // Same candidate resolution as step(), without running any action.
    can: (event) => !disposed && chooseTransition(def, snapshot, event, impl) !== undefined,
    reset: (event) => run({ kind: "reset", event }),
    dispose,
    on,
    get disposed() {
      return disposed;
    },
    get signal() {
      return controller.signal;
    },
    subscribe(listener) {
      assertListener(listener);
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subRuntime: () => childRuntime,
    onTransition: (handler, options) => on("transition", handler, options),
  };

  // §2 Bootstrap: if the initial state has a sub, instantiate the child BEFORE
  // returning. Failure throws SubMachineError(initialState, "init", cause).
  swapChild(snapshot.value, snapshot.value);

  return runtime;
}
