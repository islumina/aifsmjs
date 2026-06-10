import { describe, expect, it, vi } from "vitest";
import { RuntimeDisposedError, createRuntime } from "../../src/fsm/runtime.js";
import { type EffectLog, makeImpl, trafficLight } from "../fixtures/traffic-light.js";

describe("createRuntime", () => {
  it("returns initial snapshot", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    expect(runtime.getSnapshot().value).toBe("red");
  });

  it("send transitions state", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const r = runtime.send({ type: "NEXT" });
    expect(r.value).toBe("green");
    expect(runtime.getSnapshot().value).toBe("green");
  });

  it("subscribers fire on change only", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.send({ type: "NEXT" }); // red → green: 1 call
    runtime.send({ type: "GHOST" as unknown as "NEXT" }); // no-op: 0 calls
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("subscribe returns unsubscribe", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const listener = vi.fn();
    const unsub = runtime.subscribe(listener);
    unsub();
    runtime.send({ type: "NEXT" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispatches effects through handlers by default", () => {
    const log: EffectLog = [];
    const runtime = createRuntime(trafficLight, makeImpl(log));
    runtime.send({ type: "NEXT" });
    expect(log.some((e) => e.type === "trackTransition")).toBe(true);
  });

  it("skips dispatch when dispatchEffects=false", () => {
    const log: EffectLog = [];
    const runtime = createRuntime(trafficLight, makeImpl(log), { dispatchEffects: false });
    runtime.send({ type: "NEXT" });
    expect(log).toEqual([]);
  });

  it("middleware sees prev, next, event, effects, changed", () => {
    const seen: { prev: string; next: string; type: string; changed: boolean }[] = [];
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          seen.push({
            prev: mw.prev.value,
            next: mw.next.value,
            type: mw.event.type,
            changed: mw.changed,
          });
          next();
        },
      ],
    });
    runtime.send({ type: "NEXT" });
    expect(seen).toEqual([{ prev: "red", next: "green", type: "NEXT", changed: true }]);
  });

  it("multiple middleware run in order", () => {
    const calls: string[] = [];
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (_mw, next) => {
          calls.push("a-before");
          next();
          calls.push("a-after");
        },
        (_mw, next) => {
          calls.push("b-before");
          next();
          calls.push("b-after");
        },
      ],
    });
    runtime.send({ type: "NEXT" });
    expect(calls).toEqual(["a-before", "b-before", "b-after", "a-after"]);
  });

  it("middleware calling next() twice throws", () => {
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (_mw, next) => {
          next();
          next();
        },
      ],
    });
    expect(() => runtime.send({ type: "NEXT" })).toThrow(/next\(\) called multiple/);
  });

  it("middleware sees frozen snapshots — mutating throws in dev", () => {
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          expect(() => {
            // biome-ignore lint/suspicious/noExplicitAny: probing freeze
            (mw.next as any).value = "halt";
          }).toThrow();
          next();
        },
      ],
    });
    runtime.send({ type: "NEXT" });
  });
});

describe("runtime lifecycle — dispose / reset / signal", () => {
  it("exposes a signal that is not aborted until dispose", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    expect(runtime.signal.aborted).toBe(false);
    runtime.dispose();
    expect(runtime.signal.aborted).toBe(true);
  });

  it("disposed flag flips on dispose", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    expect(runtime.disposed).toBe(false);
    runtime.dispose();
    expect(runtime.disposed).toBe(true);
  });

  it("dispose is idempotent", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.dispose();
    expect(() => runtime.dispose()).not.toThrow();
    expect(runtime.disposed).toBe(true);
  });

  it("send after dispose throws RuntimeDisposedError", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.dispose();
    expect(() => runtime.send({ type: "NEXT" })).toThrow(RuntimeDisposedError);
  });

  it("reset after dispose throws RuntimeDisposedError", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.dispose();
    expect(() => runtime.reset()).toThrow(RuntimeDisposedError);
  });

  it("dispose clears existing listeners (no notify after dispose)", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.dispose();
    // post-dispose subscribe returns a no-op unsubscribe
    const noop = runtime.subscribe(() => {});
    expect(typeof noop).toBe("function");
    expect(listener).not.toHaveBeenCalled();
  });

  it("effect handlers receive the runtime's signal", () => {
    let captured: AbortSignal | undefined;
    const runtime = createRuntime(trafficLight, {
      ...makeImpl(),
      effects: {
        trackTransition: (_eff, { signal }) => {
          captured = signal;
        },
        logEnter: () => {},
      },
    });
    runtime.send({ type: "NEXT" });
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
    runtime.dispose();
    expect(captured?.aborted).toBe(true);
  });

  it("reset() returns to initial snapshot and notifies", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.send({ type: "NEXT" });
    runtime.send({ type: "NEXT" });
    expect(runtime.getSnapshot().value).toBe("yellow");
    expect(runtime.getSnapshot().context.ticks).toBe(2);
    const after = runtime.reset();
    expect(after.value).toBe("red");
    expect(after.context.ticks).toBe(0);
    expect(listener).toHaveBeenLastCalledWith(after);
  });

  it("reset() does not run entry actions", () => {
    const log: EffectLog = [];
    const runtime = createRuntime(trafficLight, makeImpl(log));
    runtime.send({ type: "NEXT" }); // red → green (emits trackTransition)
    log.length = 0;
    runtime.reset();
    expect(log).toEqual([]);
  });

  it("reset() with explicit event surfaces it to middleware", () => {
    let middlewareEvent: { type: string } | undefined;
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          middlewareEvent = mw.event;
          next();
        },
      ],
    });
    runtime.reset({ type: "RESET" });
    expect(middlewareEvent?.type).toBe("RESET");
  });

  it("snapshot() is an alias for getSnapshot()", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    expect(runtime.snapshot()).toBe(runtime.getSnapshot());
    runtime.send({ type: "NEXT" });
    expect(runtime.snapshot()).toBe(runtime.getSnapshot());
  });

  it("can(event) predicts whether send would fire a transition", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    expect(runtime.can({ type: "NEXT" })).toBe(true);
    expect(runtime.can({ type: "RESET" })).toBe(false); // not declared on red
    runtime.send({ type: "EMERGENCY" }); // → halt
    expect(runtime.can({ type: "NEXT" })).toBe(false); // not declared on halt
    expect(runtime.can({ type: "RESET" })).toBe(true);
  });

  it("can() returns false after dispose", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.dispose();
    expect(runtime.can({ type: "NEXT" })).toBe(false);
  });

  it("can() returns false for guarded transitions whose guards reject", () => {
    type C = { open: boolean };
    type E = { type: "GO" };
    const def = trafficLight; // not used; redefine locally
    void def;
    const local = createRuntime<C, E, "a" | "b">(
      {
        id: "g",
        initial: "a",
        context: { open: false },
        states: {
          a: { on: { GO: { target: "b", guard: "isOpen" } } },
          b: {},
        },
      },
      {
        guards: { isOpen: ({ context }) => context.open },
      },
    );
    expect(local.can({ type: "GO" })).toBe(false);
  });

  it("on('transition') fires when send changes state", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const events: string[] = [];
    runtime.on("transition", (e) => {
      events.push(`${e.prev.value}->${e.next.value}`);
    });
    runtime.send({ type: "NEXT" });
    runtime.send({ type: "NEXT" });
    expect(events).toEqual(["red->green", "green->yellow"]);
  });

  it("on('transition') skips no-op events", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const fn = vi.fn();
    runtime.on("transition", fn);
    runtime.send({ type: "GHOST" as unknown as "NEXT" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("on('transition') payload is captured pre-reentry (outer.next does not show inner's mutation)", () => {
    // Regression: send() used to use the mutable outer `snapshot` variable for
    // the transition payload's `next`. If an effect handler synchronously
    // calls send() again, the inner reassignment of `snapshot` would race
    // ahead and the outer payload's `next.value` would point at the inner
    // state instead of the state that paired with the outer event.
    const events: string[] = [];
    const runtime = createRuntime(trafficLight, {
      // `?? {}` keeps the property non-undefined under exactOptionalPropertyTypes
      // (Implementations.actions is optional, so makeImpl().actions is T|undefined).
      actions: makeImpl().actions ?? {},
      effects: {
        // The "green" entry produces no effect by default; we splice in a
        // reentry by listening to transitions and re-sending.
      },
    });
    let reenterOnce = true;
    runtime.on("transition", (e) => {
      events.push(`${e.prev.value}->${e.next.value}`);
      if (e.prev.value === "red" && reenterOnce) {
        reenterOnce = false;
        runtime.send({ type: "NEXT" }); // green -> yellow inside red->green emit
      }
    });
    runtime.send({ type: "NEXT" });
    // Order: outer emits red->green; inside that handler, inner send triggers
    // green->yellow which emits green->yellow synchronously. Both payloads
    // must reference their own outcomes, not be reordered or aliased.
    expect(events).toEqual(["red->green", "green->yellow"]);
  });

  it("reset() 'transition' payload is captured pre-reentry (FSM-B-01 / FSM-T-03)", () => {
    // Mirror of the send() re-entrancy regression above, but with reset() as
    // the OUTER call. reset() ran notify() (which fires subscribe listeners)
    // before reading the live `snapshot` for the emitted 'transition' payload.
    // A subscriber that re-entrantly send()s advances `snapshot`, so reset's
    // emitted next pointed at the re-entry's state instead of the reset target
    // — an event whose prev/next pair never actually happened.
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.send({ type: "NEXT" }); // red -> green, so reset() is a real change

    const resetPayloads: string[] = [];
    runtime.on("transition", (e) => {
      // Record only the reset event's payload (triggerEvent type is the
      // synthetic reset marker, not "NEXT").
      if (e.event.type !== "NEXT") {
        resetPayloads.push(`${e.prev.value}->${e.next.value}`);
      }
    });

    let reenterOnce = true;
    const unsub = runtime.subscribe((snap) => {
      // Fires inside reset()'s notify(); re-enter with a send() the first time.
      if (snap.value === "red" && reenterOnce) {
        reenterOnce = false;
        runtime.send({ type: "NEXT" }); // red -> green, inside reset()'s notify
      }
    });

    runtime.reset();
    unsub();

    // The reset genuinely went green -> red; its emitted payload must say so,
    // not "green->green" (aliasing the re-entry's outcome into next).
    expect(resetPayloads).toEqual(["green->red"]);
    // And the live snapshot reflects the re-entrant send that ran last.
    expect(runtime.getSnapshot().value).toBe("green");
  });

  it("on('dispose') fires once when runtime is disposed", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const fn = vi.fn();
    runtime.on("dispose", fn);
    runtime.dispose();
    runtime.dispose(); // idempotent — listener should not fire again
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("on({once}) removes the listener after first call", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const fn = vi.fn();
    runtime.on("transition", fn, { once: true });
    runtime.send({ type: "NEXT" });
    runtime.send({ type: "NEXT" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("on({signal}) removes the listener when signal aborts", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    const fn = vi.fn();
    runtime.on("transition", fn, { signal: ac.signal });
    runtime.send({ type: "NEXT" });
    ac.abort();
    runtime.send({ type: "NEXT" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("on({signal}) is a no-op when signal is already aborted", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();
    const off = runtime.on("transition", fn, { signal: ac.signal });
    expect(typeof off).toBe("function");
    off(); // exercise the no-op unsubscribe
    runtime.send({ type: "NEXT" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("on({signal}) removes abort listener from external signal on dispose", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    runtime.on("transition", vi.fn(), { signal: ac.signal });
    runtime.dispose();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("on({signal}) unsubscribe also detaches the abort listener", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const off = runtime.on("transition", vi.fn(), { signal: ac.signal });
    off();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("can() handles array-of-transitions states (yellow → fallback)", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.send({ type: "NEXT" }); // red → green
    runtime.send({ type: "NEXT" }); // green → yellow (ticks=2, even)
    // yellow.on.NEXT is an array; ticksOdd guard fails (even), fallback has no guard
    expect(runtime.can({ type: "NEXT" })).toBe(true);
  });

  it("on('error') fires for async effect handler rejections", async () => {
    const errors: unknown[] = [];
    const runtime = createRuntime(trafficLight, {
      ...makeImpl(),
      effects: {
        trackTransition: async () => {
          throw new Error("boom");
        },
        logEnter: () => {},
      },
    });
    runtime.on("error", (e) => {
      errors.push(e.error);
    });
    runtime.send({ type: "NEXT" });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("on('error') fires for a rejecting PromiseLike (non-Promise) effect result (FSM-B-03)", async () => {
    // A cross-realm Promise / user-defined thenable fails `instanceof Promise`,
    // so its rejection previously bypassed the 'error' channel and became an
    // unhandled rejection. isThenable + Promise.resolve() wrapping routes it.
    const errors: unknown[] = [];
    const rejectingThenable: PromiseLike<void> = {
      // biome-ignore lint/suspicious/noThenProperty: deliberately a PromiseLike to exercise the non-Promise thenable path
      then<TResult1 = void, TResult2 = never>(
        _onFulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve().then(() =>
          onRejected ? onRejected(new Error("thenable-boom")) : (undefined as TResult2),
        );
      },
    };
    const runtime = createRuntime(trafficLight, {
      ...makeImpl(),
      effects: {
        trackTransition: () => rejectingThenable as unknown as Promise<void>,
        logEnter: () => {},
      },
    });
    runtime.on("error", (e) => {
      errors.push(e.error);
    });
    runtime.send({ type: "NEXT" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("thenable-boom");
  });

  it("on() returned unsubscribe removes the listener", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const fn = vi.fn();
    const off = runtime.on("transition", fn);
    off();
    runtime.send({ type: "NEXT" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("on() after dispose is a no-op", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.dispose();
    const fn = vi.fn();
    const off = runtime.on("transition", fn);
    expect(typeof off).toBe("function");
    off(); // exercise the no-op
  });

  it("subscribe() after dispose returns a no-op unsubscribe that is safe to call", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    runtime.dispose();
    const off = runtime.subscribe(() => {});
    expect(() => off()).not.toThrow();
  });

  it("reset() without event uses the @@aifsmjs/RESET sentinel", () => {
    let middlewareEvent: { type: string } | undefined;
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          middlewareEvent = mw.event;
          next();
        },
      ],
    });
    runtime.reset();
    expect(middlewareEvent?.type).toBe("@@aifsmjs/RESET");
  });

  it("reset() on initial state does not notify listeners", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.reset(); // already at "red"; no change
    expect(listener).not.toHaveBeenCalled();
  });

  it("reset() middleware sees changed=false when already at initial", () => {
    let observed = true;
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          observed = mw.changed;
          next();
        },
      ],
    });
    runtime.reset();
    expect(observed).toBe(false);
  });

  it("on() once+signal detaches abort listener on first fire (memory-leak regression)", () => {
    // Regression: the old once-wrapper only called target.delete(wrapped) but
    // never invoked detachAbort, leaving the onAbort closure attached to the
    // external signal and detachAbort still in externalAbortCleanups. With a
    // long-lived signal and repeated once+signal registrations, dead closures
    // accumulate. The fix shares a single cleanup() closure across all three
    // teardown paths (once-wrapper, onAbort, returned unsubscribe).
    const runtime = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const fn = vi.fn();

    runtime.on("transition", fn, { once: true, signal: ac.signal });
    // Fire one transition — once-wrapper should run cleanup(), which detaches
    // the abort listener from the external signal.
    runtime.send({ type: "NEXT" }); // red → green

    // Handler must have fired exactly once.
    expect(fn).toHaveBeenCalledTimes(1);

    // removeEventListener("abort", ...) must have been called by cleanup() —
    // proof that the abort listener was detached when the once-wrapper fired.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // Aborting the signal after the once-handler fired must be a harmless no-op
    // (no throw, no second invocation of fn).
    expect(() => ac.abort()).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);

    // A further transition must also be a no-op for this handler.
    runtime.send({ type: "NEXT" }); // green → yellow
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
