import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { after, createScheduler } from "../../src/timer/index.js";

describe("after", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after the given delay", () => {
    const fn = vi.fn();
    after(1000, fn);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("synchronous injected setTimeout: no TDZ throw and no leaked abort listener", () => {
    // A custom `st` that fires inline must not hit the temporal-dead-zone on
    // `cancel`; and because the timer already fired, no abort listener should
    // be attached (it could never be removed via the fire path).
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    let ran = false;
    expect(() =>
      after(
        0,
        () => {
          ran = true;
        },
        {
          signal: ac.signal,
          setTimeout: (fn) => {
            fn();
            return 0;
          },
          clearTimeout: () => {},
        },
      ),
    ).not.toThrow();
    expect(ran).toBe(true);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("cancel() before firing prevents the callback", () => {
    const fn = vi.fn();
    const h = after(1000, fn);
    h.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() after firing is a no-op", () => {
    const fn = vi.fn();
    const h = after(1000, fn);
    vi.advanceTimersByTime(1000);
    h.cancel(); // no throw
    expect(fn).toHaveBeenCalledOnce();
  });

  it("AbortSignal aborts a pending timer", () => {
    const ac = new AbortController();
    const fn = vi.fn();
    after(1000, fn, { signal: ac.signal });
    ac.abort();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("already-aborted signal never schedules", () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const handle = after(1000, fn, { signal: ac.signal });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    // Calling cancel on the NOOP handle is safe (idempotent).
    expect(() => handle.cancel()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses injected setTimeout/clearTimeout", () => {
    const calls: { ms: number; fn: () => void }[] = [];
    let handle: unknown = null;
    const fakeSet = (fn: () => void, ms: number) => {
      calls.push({ ms, fn });
      handle = Symbol("h");
      return handle;
    };
    const fakeClear = vi.fn();
    const inner = vi.fn();
    const h = after(500, inner, { setTimeout: fakeSet, clearTimeout: fakeClear });
    expect(calls).toEqual([{ ms: 500, fn: expect.any(Function) }]);
    h.cancel();
    expect(fakeClear).toHaveBeenCalledWith(handle);
  });

  it("AbortSignal listener is registered with once: true", () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    after(100, () => {}, { signal: ac.signal });
    const call = addSpy.mock.calls[0];
    expect(call?.[0]).toBe("abort");
    expect(call?.[2]).toEqual({ once: true });
  });

  it("abort listener is detached via removeEventListener after timer fires (memory-leak regression)", () => {
    // Regression: { once: true } only removes the listener when the signal
    // aborts — not when the timer fires normally. Scheduling many timers on a
    // shared, long-lived signal therefore accumulates dead "abort" listeners.
    // The fix explicitly calls removeEventListener inside the fire callback.
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const fn = vi.fn();

    after(100, fn, { signal: ac.signal });

    // Timer fires — abort listener must be detached immediately.
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // Aborting the signal afterwards must be a harmless no-op.
    expect(() => ac.abort()).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("abort listener is detached via removeEventListener after cancel() (memory-leak regression)", () => {
    // Regression: cancel() cleared the timer but did not detach the abort
    // listener — dead closures accumulated on a reused signal.
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const fn = vi.fn();

    const h = after(100, fn, { signal: ac.signal });

    // Cancel before fire — abort listener must be detached.
    h.cancel();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // Timer advance must not invoke fn.
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("createScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks pending size", () => {
    const s = createScheduler();
    expect(s.size).toBe(0);
    s.after(100, () => {});
    s.after(200, () => {});
    expect(s.size).toBe(2);
  });

  it("size decreases on fire", () => {
    const s = createScheduler();
    s.after(100, () => {});
    s.after(200, () => {});
    vi.advanceTimersByTime(100);
    expect(s.size).toBe(1);
    vi.advanceTimersByTime(100);
    expect(s.size).toBe(0);
  });

  it("size decreases on cancel", () => {
    const s = createScheduler();
    const h = s.after(100, () => {});
    s.after(200, () => {});
    h.cancel();
    expect(s.size).toBe(1);
  });

  it("cancelAll clears every pending timer", () => {
    const s = createScheduler();
    const fns = [vi.fn(), vi.fn(), vi.fn()];
    for (const fn of fns) s.after(100, fn);
    s.cancelAll();
    expect(s.size).toBe(0);
    vi.advanceTimersByTime(1000);
    for (const fn of fns) expect(fn).not.toHaveBeenCalled();
  });

  it("multiple timers fire independently in correct order", () => {
    const s = createScheduler();
    const order: string[] = [];
    s.after(300, () => order.push("c"));
    s.after(100, () => order.push("a"));
    s.after(200, () => order.push("b"));
    vi.advanceTimersByTime(500);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("default options are merged into per-call options", () => {
    const fakeSet = vi.fn((fn: () => void, _ms: number) => {
      fn();
      return 0;
    });
    const s = createScheduler({ setTimeout: fakeSet });
    const inner = vi.fn();
    s.after(0, inner);
    expect(fakeSet).toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it("an explicitly-undefined per-call signal does not override the scheduler default (aifsmjs-18)", () => {
    const ac = new AbortController();
    const s = createScheduler({ signal: ac.signal });
    const fn = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: exercising a JS/non-exact-optional caller forwarding `signal: undefined`
    s.after(100, fn, { signal: undefined } as any);
    ac.abort();
    expect(s.size).toBe(0);
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("an explicitly-undefined per-call setTimeout does not override the injected default (aifsmjs-18)", () => {
    const fakeSet = vi.fn((fn: () => void, _ms: number) => {
      fn();
      return 0;
    });
    const s = createScheduler({ setTimeout: fakeSet });
    const inner = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: exercising a JS/non-exact-optional caller forwarding `setTimeout: undefined`
    s.after(0, inner, { setTimeout: undefined } as any);
    expect(fakeSet).toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it("createScheduler: abort listener detached via removeEventListener after timer fires (memory-leak regression)", () => {
    // Mirror of the after() regression test: when a signal is supplied to
    // createScheduler().after(), firing the timer must explicitly detach the
    // abort listener so a long-lived shared signal does not accumulate dead
    // closures.
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const fn = vi.fn();

    const s = createScheduler();
    s.after(100, fn, { signal: ac.signal });

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // Aborting afterwards must be a no-op.
    expect(() => ac.abort()).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("createScheduler: abort listener detached via removeEventListener after cancel() (memory-leak regression)", () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const fn = vi.fn();

    const s = createScheduler();
    const h = s.after(100, fn, { signal: ac.signal });

    h.cancel();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // FSM-R-01 — pending Set must not leak entries via the three signal paths.
  // -------------------------------------------------------------------------
  describe("pending Set does not leak on signal paths (FSM-R-01)", () => {
    it("(a) abort-mid-flight: aborting a pending timer's signal drops it from pending", () => {
      const s = createScheduler();
      const ac = new AbortController();
      const fn = vi.fn();
      s.after(1000, fn, { signal: ac.signal });
      expect(s.size).toBe(1);
      ac.abort(); // cancels the timer — must also remove the handle from pending
      expect(s.size).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("(a') abort-mid-flight with a default signal injected at construction", () => {
      const ac = new AbortController();
      const s = createScheduler({ signal: ac.signal });
      s.after(1000, () => {});
      s.after(2000, () => {});
      expect(s.size).toBe(2);
      ac.abort();
      expect(s.size).toBe(0);
    });

    it("(b) already-aborted signal: scheduling never grows pending", () => {
      const s = createScheduler();
      const ac = new AbortController();
      ac.abort();
      const fn = vi.fn();
      const h = s.after(1000, fn, { signal: ac.signal });
      // The NOOP handle must not be tracked.
      expect(s.size).toBe(0);
      expect(() => h.cancel()).not.toThrow();
      vi.advanceTimersByTime(1000);
      expect(fn).not.toHaveBeenCalled();
      expect(s.size).toBe(0);
    });

    it("(c) sync-fire: a synchronous custom setTimeout leaves pending empty", () => {
      // A custom scheduler whose setTimeout fires inline runs `wrapped` before
      // the tracked handle exists; the delete is skipped, then pending.add runs
      // anyway — leaving a permanently dead entry. After the fix, an
      // already-fired timer must not be added.
      const fn = vi.fn();
      const s = createScheduler({
        setTimeout: (cb) => {
          cb();
          return 0;
        },
        clearTimeout: () => {},
      });
      s.after(0, fn);
      expect(fn).toHaveBeenCalledOnce();
      expect(s.size).toBe(0);
    });

    it("(d) abort then explicit cancel() is idempotent (double-settle guard)", () => {
      const s = createScheduler();
      const ac = new AbortController();
      const fn = vi.fn();
      const h = s.after(1000, fn, { signal: ac.signal });
      ac.abort(); // settles once (size → 0)
      expect(s.size).toBe(0);
      expect(() => h.cancel()).not.toThrow(); // second settle is a no-op
      expect(s.size).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("(c') sync-fire then a normal timer: size reflects only the live timer", () => {
      let inline = true;
      const s = createScheduler({
        setTimeout: (cb, ms) => {
          if (inline) {
            cb();
            return 0;
          }
          return globalThis.setTimeout(cb, ms);
        },
        clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      s.after(0, () => {}); // fires inline → must not linger in pending
      expect(s.size).toBe(0);
      inline = false;
      s.after(1000, () => {}); // real pending timer
      expect(s.size).toBe(1);
    });
  });
});

describe("after() / createScheduler().after() argument rules (aifsmjs-17)", () => {
  const MAX = 2_147_483_647;

  it("rejects NaN, ±Infinity, negatives and non-numbers with RangeError before any timer", () => {
    const st = vi.fn(() => 0);
    const opts = { setTimeout: st, clearTimeout: () => {} };
    for (const ms of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse from untyped callers
      "5" as any,
    ]) {
      expect(() => after(ms, () => {}, opts)).toThrow(RangeError);
    }
    expect(() => after(-1, () => {}, opts)).toThrow(
      /^aifsmjs: after\(\) ms must be a finite number >= 0$/,
    );
    expect(st).not.toHaveBeenCalled();
  });

  it("validates before the already-aborted-signal shortcut", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => after(Number.NaN, () => {}, { signal: ac.signal })).toThrow(RangeError);
  });

  it("rejects a non-function callback with a prefixed TypeError", () => {
    const st = vi.fn(() => 0);
    // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse from untyped callers
    expect(() => after(10, undefined as any, { setTimeout: st, clearTimeout: () => {} })).toThrow(
      /^aifsmjs: after\(\) fn must be a function$/,
    );
    expect(st).not.toHaveBeenCalled();
  });

  it("clamps a finite delay above 2^31-1 to 2^31-1 when handing it to setTimeout", () => {
    const st = vi.fn((_fn: () => void, _ms: number) => 0);
    after(2 ** 31, () => {}, { setTimeout: st, clearTimeout: () => {} });
    after(Number.MAX_SAFE_INTEGER, () => {}, { setTimeout: st, clearTimeout: () => {} });
    after(MAX, () => {}, { setTimeout: st, clearTimeout: () => {} });
    after(0, () => {}, { setTimeout: st, clearTimeout: () => {} });
    expect(st.mock.calls.map((c) => c[1])).toEqual([MAX, MAX, MAX, 0]);
  });

  it("a clamped timer does not fire early", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      after(2 ** 31, fn);
      vi.advanceTimersByTime(1000);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(MAX);
      expect(fn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("createScheduler().after inherits the rules; a rejected call leaves size at 0", () => {
    const st = vi.fn((_fn: () => void, _ms: number) => 0);
    const s = createScheduler({ setTimeout: st, clearTimeout: () => {} });
    expect(() => s.after(Number.POSITIVE_INFINITY, () => {})).toThrow(RangeError);
    // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse from untyped callers
    expect(() => s.after(5, null as any)).toThrow(TypeError);
    const ac = new AbortController();
    ac.abort();
    expect(() => s.after(Number.NaN, () => {}, { signal: ac.signal })).toThrow(RangeError);
    expect(s.size).toBe(0);
    expect(st).not.toHaveBeenCalled();
    s.after(2 ** 31, () => {});
    expect(st.mock.calls[0]?.[1]).toBe(MAX);
    expect(s.size).toBe(1);
  });
});
