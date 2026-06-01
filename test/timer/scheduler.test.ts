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
});
