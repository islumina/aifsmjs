import { initialSnapshot } from "./definition.js";
import { evalGuard, isThenable } from "./evaluator.js";
import { step } from "./lifecycle.js";
import { normalizeTransitions } from "./resolver.js";
import { deepFreeze } from "./snapshot.js";
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
 * Invariants:
 * - `phase: "init"` — child constructor threw. Parent snapshot was rolled
 *   back to `prev`; no middleware ran; no `'transition'` emitted; no effects.
 * - `phase: "dispose"` — previous child's `dispose()` threw during transition.
 *   Parent snapshot was rolled back to `prev`; child reference is cleared.
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

/**
 * Build a thin stateful runtime around a machine. `send()` calls `step()`,
 * runs the read-only middleware pipeline, dispatches effects, and notifies
 * subscribers. The runtime owns an `AbortController`; `dispose()` aborts it
 * and clears all state.
 */
export function createRuntime<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  opts: RuntimeOptions<Ctx, Evt, States> = {},
): Runtime<Ctx, Evt, States> {
  let snapshot: Snapshot<Ctx, States> = initialSnapshot(def);
  const listeners = new Set<(snap: Snapshot<Ctx, States>) => void>();
  const middlewareChain =
    opts.middleware && opts.middleware.length > 0 ? composeMiddleware(opts.middleware) : undefined;
  const shouldDispatch = opts.dispatchEffects !== false;
  const controller = new AbortController();
  let disposed = false;
  // §3.1 sub-machine state. childRuntime is the live child; childAbortCleanup
  // detaches the parent-abort listener attached by wireChildAbort. Both are
  // cleared together whenever the child is replaced or disposed (P1-3 fix).
  let childRuntime: Runtime<unknown, { type: string }, string> | undefined;
  let childAbortCleanup: (() => void) | undefined;

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
    // Snapshot-before-iterate (family canonical, aieventjs .slice()): a
    // listener that subscribes/unsubscribes another during dispatch must not
    // mutate the set being walked. One array alloc per emit, matching the
    // family's accepted cost (FAM-S-03).
    for (const fn of Array.from(eventListeners[type])) fn(payload);
  }

  function notify(committed?: Snapshot<Ctx, States>) {
    const captured = committed ?? snapshot;
    // Snapshot-before-iterate, as above (FAM-S-03).
    for (const l of Array.from(listeners)) l(captured);
  }

  function runMiddleware(
    prev: Snapshot<Ctx, States>,
    event: Evt | ResetEvent,
    effects: readonly Effect[],
    changed: boolean,
  ) {
    if (!middlewareChain) return;
    middlewareChain(deepFreeze({ prev, next: snapshot, event, effects, changed }), () => {});
  }

  function dispatchEffects(effects: readonly Effect[], context: Ctx, event: Evt): void {
    if (!impl.effects || effects.length === 0) return;
    for (const eff of effects) {
      const handler = impl.effects[eff.type];
      if (!handler) continue;
      const r = handler(eff, { context, event, signal: controller.signal });
      // isThenable (not instanceof Promise) so cross-realm Promises and
      // user-defined PromiseLike results also have their rejections routed to
      // the 'error' channel; Promise.resolve() normalises them (FSM-B-03).
      if (isThenable(r)) {
        Promise.resolve(r).catch((err: unknown) => {
          emit("error", { error: err, event });
        });
      }
    }
  }

  // §3.1 Attach one-shot abort listener: parent dispose → child.dispose().
  // Returns a cleanup fn that detaches the listener; caller stores it in
  // `childAbortCleanup` and invokes when the child is replaced/disposed
  // (P1-3 fix: prevent stale listeners accumulating on the parent signal).
  function wireChildAbort(child: Runtime<unknown, { type: string }, string>): () => void {
    /* v8 ignore next 7 — parent may already be aborted in edge cases; dispose still runs */
    if (controller.signal.aborted) {
      try {
        child.dispose();
      } catch {
        /* swallow */
      }
      return () => {};
    }
    /* v8 ignore next 7 — defensive: dispose() pre-cleans this listener and
       disposes the child manually before calling controller.abort(), so
       onAbort fires only if external code aborts the controller bypassing
       dispose(). Internal-only controller has no such external path today. */
    const onAbort = () => {
      try {
        child.dispose();
      } catch {
        /* swallow */
      }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    return () => controller.signal.removeEventListener("abort", onAbort);
  }

  // §3.3 Re-resolve guards to find the chosen transition and determine
  // whether it is external (has a `target`). Replaces the v0.3.0 dev
  // hasSelfTargetMarker heuristic that over-reported when an event had both
  // internal (no-target) and self-target (target === value) candidates
  // (P1-2 fix). Cost: one extra guard evaluation pass per same-value event.
  function findChosenIsExternal(value: States, event: Evt, context: Ctx): boolean {
    const state = def.states[value];
    if (!state?.on) return false;
    const list = normalizeTransitions(state.on[event.type]);
    if (list.length === 0) return false;
    for (const t of list) {
      if (!t.guard || evalGuard(t.guard, context, event, impl, value)) {
        return t.target !== undefined;
      }
    }
    /* v8 ignore next — defensive: caller only invokes when step() returned
       changed=true, which guarantees a matching guard exists in the same
       candidate list. The for-loop above always returns before this line. */
    return false;
  }

  // §3.1 Dispose old child and/or init new child. Throws SubMachineError on failure.
  // Caller must NOT commit snapshot on throw.
  function applySubLifecycle(prevValue: States, nextValue: States): void {
    const prevStateDef = def.states[prevValue];
    const nextStateDef = def.states[nextValue];
    if (prevStateDef?.sub !== undefined && childRuntime !== undefined) {
      const child = childRuntime;
      childRuntime = undefined;
      childAbortCleanup?.();
      childAbortCleanup = undefined;
      try {
        child.dispose();
      } catch (cause) {
        throw new SubMachineError(prevValue as string, "dispose", cause);
      }
    }
    if (nextStateDef?.sub !== undefined) {
      let newChild: Runtime<unknown, { type: string }, string>;
      try {
        newChild = createRuntime(nextStateDef.sub, nextStateDef.subImpl ?? {});
      } catch (cause) {
        throw new SubMachineError(nextValue as string, "init", cause);
      }
      childRuntime = newChild;
      childAbortCleanup = wireChildAbort(newChild);
    }
  }

  function send(event: Evt): Snapshot<Ctx, States> {
    if (disposed) throw new RuntimeDisposedError();
    const prev = snapshot;
    const result = step(def, prev, event, impl);
    const isExternal =
      result.changed &&
      (prev.value !== result.snapshot.value ||
        findChosenIsExternal(prev.value, event, prev.context));
    // Sub lifecycle BEFORE snapshot commit (§3.4); throws SubMachineError on failure → no commit
    if (result.changed && isExternal) applySubLifecycle(prev.value, result.snapshot.value);
    snapshot = result.snapshot;
    const committed = result.snapshot;
    runMiddleware(prev, event, result.effects, result.changed);
    if (shouldDispatch) dispatchEffects(result.effects, committed.context, event);
    if (result.changed) {
      notify(committed);
      emit("transition", {
        prev,
        next: committed,
        event,
        effects: result.effects,
        changed: true,
      } as RuntimeTransitionEvent<Ctx, Evt, States>);
    }
    return snapshot;
  }

  function reset(event?: Evt): Snapshot<Ctx, States> {
    if (disposed) throw new RuntimeDisposedError();
    const prev = snapshot;
    const nextSnap = initialSnapshot(def);
    const changed = prev.value !== nextSnap.value;
    // Dispose current child (§3.5)
    if (childRuntime) {
      const child = childRuntime;
      childRuntime = undefined;
      childAbortCleanup?.();
      childAbortCleanup = undefined;
      try {
        child.dispose();
      } catch (cause) {
        throw new SubMachineError(prev.value as string, "dispose", cause);
      }
    }
    // Init child for new initial state if it has sub (§3.5)
    const initStateDef = def.states[nextSnap.value];
    if (initStateDef?.sub) {
      let newChild: Runtime<unknown, { type: string }, string>;
      try {
        newChild = createRuntime(initStateDef.sub, initStateDef.subImpl ?? {});
      } catch (cause) {
        /* v8 ignore next — reset() init failure: only reachable if frozen sub def somehow rejects post-bootstrap */
        throw new SubMachineError(nextSnap.value as string, "init", cause);
      }
      childRuntime = newChild;
      childAbortCleanup = wireChildAbort(newChild);
    }
    snapshot = nextSnap;
    // Capture the committed snapshot before notify()/emit so a subscriber that
    // re-entrantly send()s (which advances the mutable `snapshot`) cannot
    // corrupt this reset's payload — mirrors send()'s 0.2.0 fix (FSM-B-01).
    const committed = nextSnap;
    const triggerEvent: Evt | ResetEvent = event ?? RESET_EVENT;
    runMiddleware(prev, triggerEvent, [], changed);
    if (changed) {
      notify(committed);
      emit("transition", {
        prev,
        next: committed,
        event: triggerEvent,
        effects: [],
        changed: true,
      } as RuntimeTransitionEvent<Ctx, Evt, States>);
    }
    // Return the live snapshot (consistent with send()): under a re-entrant
    // send() from a subscriber, this reflects the latest committed state. Only
    // the emitted payload above is pinned to this reset's own outcome.
    return snapshot;
  }

  function can(event: Evt): boolean {
    if (disposed || snapshot.status === "final") return false;
    const state = def.states[snapshot.value];
    /* v8 ignore next — defensive: snapshot.value always corresponds to a declared state. */
    if (!state) return false;
    const list = normalizeTransitions(state.on?.[event.type]);
    if (list.length === 0) return false;
    for (const t of list) {
      if (!t.guard) return true;
      if (evalGuard(t.guard, snapshot.context, event, impl, snapshot.value)) return true;
    }
    return false;
  }

  function on<K extends keyof RuntimeEventMap<Ctx, Evt, States>>(
    type: K,
    listener: (payload: RuntimeEventMap<Ctx, Evt, States>[K]) => void,
    options?: { signal?: AbortSignal; once?: boolean },
  ): () => void {
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
    // Cascade child dispose; swallow exceptions (dispose contract) (§3.6)
    if (childRuntime) {
      childAbortCleanup?.();
      childAbortCleanup = undefined;
      try {
        childRuntime.dispose();
      } catch {
        /* swallow */
      }
      childRuntime = undefined;
    }
    controller.abort();
    listeners.clear();
    emit("dispose", undefined as RuntimeEventMap<Ctx, Evt, States>["dispose"]);
    for (const set of Object.values(eventListeners)) set.clear();
    for (const cleanup of externalAbortCleanups) cleanup();
    externalAbortCleanups.clear();
  }

  const runtime: Runtime<Ctx, Evt, States> = {
    getSnapshot: () => snapshot,
    snapshot: () => snapshot,
    send,
    can,
    reset,
    dispose,
    on,
    get disposed() {
      return disposed;
    },
    get signal() {
      return controller.signal;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subRuntime: () => childRuntime,
    onTransition: (handler, options) => on("transition", handler, options),
  };

  // §2 Bootstrap: if initial state has sub, instantiate child BEFORE returning.
  // Failure throws SubMachineError(initialState, "init", cause) from createRuntime itself.
  const bootStateDef = def.states[snapshot.value];
  if (bootStateDef?.sub) {
    let newChild: Runtime<unknown, { type: string }, string>;
    try {
      newChild = createRuntime(bootStateDef.sub, bootStateDef.subImpl ?? {});
    } catch (cause) {
      throw new SubMachineError(snapshot.value as string, "init", cause);
    }
    childRuntime = newChild;
    childAbortCleanup = wireChildAbort(newChild);
  }

  return runtime;
}
