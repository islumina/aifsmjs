// All public types live here so AI agents and humans can read the entire
// public surface in one file.

export type Effect = Readonly<{ type: string; payload?: unknown }>;

export type Enqueuer = Readonly<{
  effect: (type: string, payload?: unknown) => void;
}>;

export type GuardArgs<Ctx, Evt> = Readonly<{
  context: Ctx;
  event: Evt;
  /**
   * Optional guard registry, threaded by `evalGuard` so combinators can resolve
   * string refs nested inside `and / or / not`. Inline user guards may safely
   * ignore this field — it is `undefined` when guards are evaluated outside of
   * `evalGuard` (e.g. in unit tests calling the function directly).
   */
  guards?: Readonly<Record<string, Guard<Ctx, Evt>>>;
  /**
   * Current state value, threaded by `evalGuard` from the live snapshot. Used
   * by the `stateIn` combinator. `undefined` when guards are called outside of
   * a lifecycle evaluation.
   */
  value?: string;
}>;

export type Guard<Ctx, Evt> = (args: GuardArgs<Ctx, Evt>) => boolean;

export type Action<Ctx, Evt> = (args: {
  context: Ctx;
  event: Evt;
  enqueue: Enqueuer;
}) => Partial<Ctx> | void;

export type EffectHandler<Ctx, Evt> = (
  effect: Effect,
  args: { context: Ctx; event: Evt; signal: AbortSignal },
) => void | Promise<void>;

export type GuardRef<Ctx, Evt> = string | Guard<Ctx, Evt>;
export type ActionRef<Ctx, Evt> = string | Action<Ctx, Evt>;

export type TransitionDef<Ctx, Evt, States extends string> = Readonly<{
  target?: States;
  guard?: GuardRef<Ctx, Evt>;
  actions?: readonly ActionRef<Ctx, Evt>[];
}>;

/**
 * A single transition as written in a `StateDef.on` map. Either the full
 * {@link TransitionDef} object form, or the string shorthand `"targetState"`
 * (à la XState) which the resolver normalizes to `{ target: "targetState" }`
 * before processing. The shorthand carries no guard or actions.
 *
 * @since 0.5.3
 */
export type TransitionConfig<Ctx, Evt, States extends string> =
  | States
  | TransitionDef<Ctx, Evt, States>;

/**
 * @experimental v0.3.0
 *
 * A nested machine definition attachable to StateDef.sub. The type parameters
 * are independent from the parent machine's <Ctx, Evt, States>; sub-machines
 * may have entirely unrelated context and event shapes.
 *
 * This is an alias for MachineDef — sub-machines have the same definition
 * shape as top-level machines. The relationship is purely lifecycle:
 * a sub-machine instance is created when its parent state becomes active
 * and disposed when the parent state exits.
 */
export type SubMachineDef<
  SubCtx,
  SubEvt extends { type: string },
  SubStates extends string,
> = MachineDef<SubCtx, SubEvt, SubStates>;

export type StateDef<Ctx, Evt, States extends string> = Readonly<{
  on?: Readonly<
    Record<
      string,
      TransitionConfig<Ctx, Evt, States> | readonly TransitionConfig<Ctx, Evt, States>[]
    >
  >;
  entry?: readonly ActionRef<Ctx, Evt>[];
  exit?: readonly ActionRef<Ctx, Evt>[];
  final?: boolean;
  /**
   * Optional sub-machine. When the runtime enters a state with `sub`,
   * the sub-machine is lazily instantiated; when it exits, the sub-machine
   * is disposed. See STABILITY.md for the experimental contract.
   *
   * The generic parameters are erased to `any` because sub-machine type
   * parameters are intentionally independent from the parent's `Ctx` / `Evt`
   * / `States`. `MachineDef`'s generics are invariant (guards / actions
   * consume them), so the storage position must use `any` rather than
   * `unknown`. Caller narrows via `runtime.subRuntime() as Runtime<...>`.
   *
   * @experimental since 0.3.0
   */
  // biome-ignore lint/suspicious/noExplicitAny: see JSDoc — invariant generic escape hatch
  sub?: MachineDef<any, any, any>;
  /**
   * Implementations for `sub`. Ignored if `sub` is absent. Defaults to `{}`
   * (sub-machine must rely on inline guards / actions / effects only).
   *
   * @experimental since 0.3.0
   */
  // biome-ignore lint/suspicious/noExplicitAny: same reason as `sub` above
  subImpl?: Implementations<any, any>;
}>;

export type MachineDef<Ctx, Evt extends { type: string }, States extends string> = Readonly<{
  id: string;
  initial: States;
  context: Ctx;
  states: Readonly<Record<States, StateDef<Ctx, Evt, States>>>;
}>;

/**
 * Input shape accepted by `defineMachine` / `setup().defineMachine`. Identical
 * to {@link MachineDef} except `context` is **optional** — when omitted it
 * defaults to `{}` (paired with the `Ctx = Record<string, never>` default type
 * parameter). The returned value is always a fully-normalized
 * {@link MachineDef} with `context` present, so downstream consumers are
 * unaffected.
 *
 * @since 0.5.3
 */
export type MachineConfig<Ctx, Evt extends { type: string }, States extends string> = Readonly<{
  id: string;
  initial: States;
  states: Readonly<Record<States, StateDef<Ctx, Evt, States>>>;
}> &
  // `context` may be omitted only when `Ctx` has no required properties (e.g. the
  // default `Record<string, never>`). If `Ctx` has required fields it must be
  // supplied, so omitting it can't silently default to `{}` and crash at runtime.
  (Record<string, never> extends Ctx ? { readonly context?: Ctx } : { readonly context: Ctx });

export type Snapshot<Ctx, States extends string> = Readonly<{
  value: States;
  context: Ctx;
  status: "active" | "final";
}>;

export type Implementations<Ctx, Evt> = Readonly<{
  guards?: Readonly<Record<string, Guard<Ctx, Evt>>>;
  actions?: Readonly<Record<string, Action<Ctx, Evt>>>;
  effects?: Readonly<Record<string, EffectHandler<Ctx, Evt>>>;
}>;

export type StepResult<Ctx, States extends string> = Readonly<{
  snapshot: Snapshot<Ctx, States>;
  effects: readonly Effect[];
  changed: boolean;
}>;

/**
 * Sentinel event type that `Runtime.reset()` synthesises when the caller does
 * not pass an explicit event. Middleware receives it through
 * `MiddlewareContext.event`. Exposed so user code can discriminate.
 */
export const RESET_EVENT_TYPE = "@@aifsmjs/RESET" as const;
export type ResetEvent = Readonly<{ type: typeof RESET_EVENT_TYPE }>;

export type MiddlewareContext<Ctx, Evt, States extends string> = Readonly<{
  prev: Snapshot<Ctx, States>;
  next: Snapshot<Ctx, States>;
  /**
   * The triggering event. May be the user's `Evt` (from `send()` or an
   * explicit `reset(event)`) or the `ResetEvent` sentinel emitted by a
   * `reset()` with no event argument. This is the caller's event object,
   * passed unfrozen; treat it as read-only.
   */
  event: Evt | ResetEvent;
  /** Deep-frozen effect descriptors (payloads included) about to be dispatched. */
  effects: readonly Effect[];
  changed: boolean;
}>;

export type Middleware<Ctx, Evt, States extends string> = (
  ctx: MiddlewareContext<Ctx, Evt, States>,
  next: () => void,
) => void;

/**
 * Payload of the `'transition'` runtime event — emitted whenever a transition
 * fired (`changed === true`), including an internal transition whose state
 * `value` did not change (only its `context` did).
 */
export type RuntimeTransitionEvent<Ctx, Evt, States extends string> = Readonly<{
  prev: Snapshot<Ctx, States>;
  next: Snapshot<Ctx, States>;
  event: Evt | ResetEvent;
  effects: readonly Effect[];
  changed: boolean;
}>;

/**
 * Payload of the `'error'` runtime event — currently emitted for async effect
 * handler rejections (which would otherwise become unhandled). With no
 * `'error'` listener (none registered, or cleared by `dispose()`) a rejection
 * is discarded; outside production (`NODE_ENV !== "production"`) it is also
 * reported via `console.warn`. Synchronous throws from effect handlers and
 * middleware still propagate to the caller of `send()` / `reset()`.
 */
export type RuntimeErrorEvent<Evt> = Readonly<{
  error: unknown;
  event: Evt | ResetEvent | undefined;
}>;

export type RuntimeEventMap<Ctx, Evt, States extends string> = {
  transition: RuntimeTransitionEvent<Ctx, Evt, States>;
  error: RuntimeErrorEvent<Evt>;
  dispose: void;
};

export interface Runtime<Ctx, Evt extends { type: string }, States extends string> {
  getSnapshot(): Snapshot<Ctx, States>;
  /** Alias for `getSnapshot()`. */
  snapshot(): Snapshot<Ctx, States>;
  /**
   * Process `event`: `step()` -> sub-machine lifecycle -> commit ->
   * middleware -> effects -> `subscribe` listeners -> `'transition'`
   * listeners, then return the committed snapshot.
   *
   * Run-to-completion: a `send()`/`reset()` made while this runtime is already
   * processing an event (from middleware, an effect handler, a listener, or a
   * child runtime's listener) is queued FIFO and processed after the current
   * event's last notification, with the same full sequence. Such a nested
   * call returns the snapshot committed at the time of the call, not the
   * outcome of its own event — read `getSnapshot()` after the outermost call
   * returns (or subscribe). A throw from any queued event discards the rest
   * of the queue and propagates from the outermost call.
   *
   * Throws `RuntimeDisposedError` after `dispose()`, and
   * `InvalidDefinitionError` when `event` is not an object with a string
   * `type`.
   */
  send(event: Evt): Snapshot<Ctx, States>;
  /**
   * Predict whether sending `event` would fire a transition. Reuses
   * `resolveTransitions` + `evalGuard` without applying any actions. Guards
   * are expected to be pure; `can` then matches `send` for the same input.
   */
  can(event: Evt): boolean;
  /**
   * Call `listener` with the committed snapshot after every event that fired
   * a transition (`changed === true`), after middleware and effects and before
   * `'transition'` listeners. A listener removed during a notification round
   * is skipped for the rest of it; one added waits for the next event.
   * Throws `InvalidDefinitionError` if `listener` is not a function. Returns
   * an unsubscribe function (a no-op after `dispose()`).
   */
  subscribe(listener: (snap: Snapshot<Ctx, States>) => void): () => void;
  /**
   * EventTarget-like typed listener API. Returns an unsubscribe function.
   * `options.signal` removes the listener when aborted; `options.once`
   * removes the listener before its first invocation. A listener removed
   * while an event is being dispatched (by its unsubscribe, `once`, its
   * signal, or `dispose()`) is skipped for the rest of that dispatch; one
   * added waits for the next event. Throws `InvalidDefinitionError` for an
   * unknown event `type` or a non-function `listener`. After `dispose()`,
   * `on()` is a no-op and returns a no-op unsubscribe.
   */
  on<K extends keyof RuntimeEventMap<Ctx, Evt, States>>(
    type: K,
    listener: (payload: RuntimeEventMap<Ctx, Evt, States>[K]) => void,
    options?: { signal?: AbortSignal; once?: boolean },
  ): () => void;
  /**
   * Re-initialise the runtime to the definition's initial snapshot. Does NOT
   * run entry actions (reset = re-birth, not "transition into initial"); the
   * current sub-machine child is always replaced. Notifies subscribers,
   * middleware (`changed: true`) and `'transition'` listeners whenever the
   * value, status, or context reference differs from the initial snapshot.
   * Throws RuntimeDisposedError if disposed. If an `event` is supplied (an
   * object with a string `type`, else `InvalidDefinitionError`), middleware
   * sees it as the trigger; otherwise a sentinel
   * `{ type: "@@aifsmjs/RESET" }` is synthesised. Run-to-completion like
   * `send()`: a nested call is queued.
   */
  reset(event?: Evt): Snapshot<Ctx, States>;
  /**
   * Tear down: abort the internal AbortController (effect handlers see signal
   * fire), clear listeners, and mark this runtime as disposed. Subsequent
   * send()/reset() calls throw RuntimeDisposedError. Idempotent and never
   * throws. Never queued: called during a dispatch it runs at once, drops any
   * queued send()/reset() calls, and the outer call returns the last
   * committed snapshot.
   */
  dispose(): void;
  /**
   * True after `dispose()` has been called.
   */
  readonly disposed: boolean;
  /**
   * AbortSignal scoped to this runtime's lifetime. Fires once on dispose().
   * Threaded to every EffectHandler invocation; external integrations
   * (e.g. component teardown) can also attach `signal.addEventListener("abort", ...)`.
   */
  readonly signal: AbortSignal;
  /**
   * @experimental v0.3.0
   *
   * Returns the currently active sub-Runtime for the current parent state,
   * or undefined if:
   *   - the current state has no `sub` definition, OR
   *   - the previous child's `dispose()` threw during a transition
   *     (SubMachineError phase "dispose"; the parent stays in its state and
   *     the child is recreated when the state is re-entered), OR
   *   - the parent runtime has been disposed.
   *
   * When a transition's new child fails to initialise (SubMachineError phase
   * "init"), the previous child is left untouched and is still returned. A
   * child that fails to initialise at `createRuntime` bootstrap makes
   * `createRuntime` itself throw, so there is no runtime to ask.
   *
   * The returned Runtime is typed at the loosest sub-machine signature.
   * Caller casts to the concrete sub type.
   *
   * Re-entry: when the parent leaves and re-enters a state with `sub`, a
   * fresh sub-Runtime is constructed. Previous sub-Runtime references held
   * by the caller are stale and MUST NOT be used (disposed).
   */
  subRuntime(): Runtime<unknown, { type: string }, string> | undefined;
  /**
   * Semantic sugar for `runtime.on('transition', handler, opts)`. Returns
   * the same unsubscribe function. Sharing the same listener Set with
   * `on('transition', ...)` means registration order determines invocation
   * order across both APIs.
   *
   * @since 0.3.0
   */
  onTransition(
    handler: (payload: RuntimeTransitionEvent<Ctx, Evt, States>) => void,
    options?: { signal?: AbortSignal; once?: boolean },
  ): () => void;
}

export type RuntimeOptions<Ctx, Evt, States extends string> = Readonly<{
  middleware?: readonly Middleware<Ctx, Evt, States>[];
  /**
   * If false, do not dispatch effects through the effect handler map.
   * Useful for replay / dry-run modes. Defaults to true.
   */
  dispatchEffects?: boolean;
}>;
