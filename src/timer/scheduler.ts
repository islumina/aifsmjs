export type AfterHandle = Readonly<{
  cancel(): void;
}>;

export type SetTimeoutFn = (fn: () => void, ms: number) => unknown;
export type ClearTimeoutFn = (handle: unknown) => void;

export type AfterOptions = Readonly<{
  /**
   * If supplied and aborted, the callback never runs and any pending timer is
   * cleared. Aborting after fire is a no-op.
   */
  signal?: AbortSignal;
  /**
   * Override `setTimeout` (testing, SSR, custom loops). Defaults to globalThis.
   */
  setTimeout?: SetTimeoutFn;
  /**
   * Override `clearTimeout`. Must match the `setTimeout` you injected.
   */
  clearTimeout?: ClearTimeoutFn;
}>;

const NOOP: AfterHandle = Object.freeze({ cancel: () => {} });

// Largest delay setTimeout honours (2^31-1 ms, about 24.8 days); hosts treat
// anything larger as ~1 ms. Every delay handed to setTimeout goes through
// clampDelay (ai*js timer rule; no timer chaining).
const MAX_DELAY = 2_147_483_647;
const clampDelay = (ms: number): number => Math.min(ms, MAX_DELAY);

// Argument validation shared by after() and createScheduler().after(), run
// before any side effect. aifsmjs/timer exports no error class, so misuse is
// a prefixed built-in RangeError / TypeError.
function checkArgs(ms: unknown, fn: unknown): void {
  if (!Number.isFinite(ms) || (ms as number) < 0) {
    throw new RangeError("aifsmjs: after() ms must be a finite number >= 0");
  }
  if (typeof fn !== "function") throw new TypeError("aifsmjs: after() fn must be a function");
}

function resolveTimers(opts: AfterOptions | undefined): {
  st: SetTimeoutFn;
  ct: ClearTimeoutFn;
} {
  return {
    st: opts?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    ct: opts?.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number)),
  };
}

/**
 * Schedule `fn` to run after `ms` milliseconds. Returns a handle whose
 * `cancel()` clears the pending timer. Optional `signal` aborts the timer when
 * triggered. Aborting after the callback fires is a no-op.
 *
 * `ms` must be a finite number >= 0 (`NaN`, `Infinity`, negatives and
 * non-numbers throw `RangeError`) and `fn` a function (`TypeError`); both are
 * checked before anything else, including an already-aborted `signal`. A
 * finite `ms` above 2^31-1 (about 24.8 days) is clamped to 2^31-1 when handed
 * to `setTimeout`. To mean "never", do not schedule.
 *
 * The abort listener is registered with `{ once: true }` as a baseline, but
 * `{ once: true }` alone does NOT prevent listener accumulation when the same
 * signal is reused across many timers: it only removes the listener when the
 * signal aborts, not when the timer fires normally or `cancel()` is called.
 * We therefore explicitly call `signal.removeEventListener("abort", cancel)`
 * inside the fire callback and at the end of `cancel()` so that a shared,
 * long-lived signal never accumulates dead listeners across timer reuse.
 */
export function after(ms: number, fn: () => void, opts?: AfterOptions): AfterHandle {
  checkArgs(ms, fn);
  if (opts?.signal?.aborted) return NOOP;

  const { st, ct } = resolveTimers(opts);
  let fired = false;
  let cancelled = false;
  // `cancel` and the timer handle reference each other. A const cell holds the
  // handle so `cancel` can be defined BEFORE `st(...)` runs (letting a custom
  // `st` that fires its callback synchronously reference `cancel` without
  // hitting the temporal-dead-zone) while still being able to clear the handle
  // assigned afterwards. A synchronous fire sets `fired=true`, so cancel() never
  // reads the still-unset handle in that path.
  const timer: { handle?: ReturnType<typeof st> } = {};

  const cancel = () => {
    if (fired || cancelled) return;
    cancelled = true;
    if (timer.handle !== undefined) ct(timer.handle);
    // Detach the abort listener so a reused signal does not accumulate dead
    // closures after this timer is cancelled.
    if (opts?.signal) opts.signal.removeEventListener("abort", cancel);
  };

  timer.handle = st(() => {
    fired = true;
    /* v8 ignore next — defensive race guard: cancel() sets cancelled=true and clears the timer, but if a custom setTimeout fires after clear, this short-circuits fn(). */
    if (cancelled) return;
    // Detach the abort listener now that the timer has fired — the listener
    // will never be invoked and must not accumulate on a reused signal.
    if (opts?.signal) opts.signal.removeEventListener("abort", cancel);
    fn();
  }, clampDelay(ms));

  // Attach only if the timer has not already fired synchronously (a custom `st`
  // may fire inline); otherwise the listener would be registered AFTER the fire
  // path's removal ran and would then leak until the signal aborts.
  if (opts?.signal && !fired) {
    opts.signal.addEventListener("abort", cancel, { once: true });
  }

  return Object.freeze({ cancel });
}

export type Scheduler = Readonly<{
  after(ms: number, fn: () => void, opts?: AfterOptions): AfterHandle;
  cancelAll(): void;
  readonly size: number;
}>;

/**
 * Build a scheduler that tracks every pending `after()` so they can be
 * cancelled together (e.g. on machine destroy). Each `after` returns a handle
 * whose `cancel()` also removes it from the tracking set.
 *
 * `defaults` are merged into every call — typically you inject `setTimeout` /
 * `clearTimeout` once at construction.
 */
export function createScheduler(defaults?: AfterOptions): Scheduler {
  const pending = new Set<AfterHandle>();

  const sched: Scheduler = {
    after(ms, fn, opts) {
      // Same validation as after(), before the aborted-signal shortcut and
      // before `pending` is touched.
      checkArgs(ms, fn);
      // Field-by-field merge with `??`: an explicitly-undefined per-call field
      // (common when forwarding optional options in JS, or in TS without
      // exactOptionalPropertyTypes) must fall back to the scheduler's default,
      // not silently win over it the way `{ ...defaults, ...opts }` would.
      // Built with `exactOptionalPropertyTypes` in mind: an option that ends
      // up undefined after the merge is left OUT of the object rather than
      // set to `undefined`, so the AfterOptions type is honoured exactly.
      const signal = opts?.signal ?? defaults?.signal;
      const setTimeoutFn = opts?.setTimeout ?? defaults?.setTimeout;
      const clearTimeoutFn = opts?.clearTimeout ?? defaults?.clearTimeout;
      // Signal handling is lifted to the scheduler layer: we own one abort
      // listener per timer and route it through the scheduler-level cancel so
      // the abort path also removes the handle from `pending`. The inner
      // after() therefore must NOT see the signal — otherwise it would clear
      // its timer on abort without ever touching `pending`, leaking the entry
      // (FSM-R-01, path a).
      const innerOpts: AfterOptions = {
        ...(setTimeoutFn !== undefined && { setTimeout: setTimeoutFn }),
        ...(clearTimeoutFn !== undefined && { clearTimeout: clearTimeoutFn }),
      };

      // Path b: scheduling on an already-aborted signal must not grow the Set.
      // after() returns NOOP in that case; tracking it would be a permanent
      // dead entry. Return the same NOOP without adding.
      if (signal?.aborted) return NOOP;

      // Forward-reference slot so `wrapped`/`cancel` can find the tracked
      // handle before it is constructed below.
      const slot: { ref?: AfterHandle } = {};
      let fired = false;
      let settled = false; // true once removed from pending (fire or cancel)

      const detachAbort = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      // Single removal path shared by fire, explicit cancel, and abort.
      const settle = () => {
        if (settled) return;
        settled = true;
        if (slot.ref) pending.delete(slot.ref);
        detachAbort();
      };

      const wrapped = () => {
        fired = true;
        settle();
        fn();
      };

      // Scheduler-level cancel: cancel the inner timer AND drop from pending
      // AND detach the abort listener. Registered on the abort path too.
      const cancel = () => {
        inner.cancel();
        settle();
      };
      function onAbort() {
        cancel();
      }

      const inner = after(ms, wrapped, innerOpts);

      const handle: AfterHandle = Object.freeze({ cancel });
      slot.ref = handle;

      // Path c (sync-fire): a custom setTimeout may fire `wrapped` inline,
      // during the after() call above — before we reach here. In that case the
      // timer is already done; adding it now would leave a permanent dead
      // entry. Only track timers that are still live.
      if (!fired) {
        pending.add(handle);
        // Attach the abort listener only for a live timer on a real signal.
        // { once: true } removes it on abort; settle()/detachAbort() remove it
        // on fire/cancel so a long-lived shared signal never accumulates dead
        // listeners.
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
      }

      return handle;
    },
    cancelAll() {
      for (const h of pending) h.cancel();
      pending.clear();
    },
    get size() {
      return pending.size;
    },
  };
  return sched;
}
