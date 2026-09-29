import { describe, expect, it, vi } from "vitest";
import { InvalidDefinitionError, defineMachine } from "../../src/fsm/definition.js";
import { RuntimeDisposedError, createRuntime } from "../../src/fsm/runtime.js";
import type { Implementations, MiddlewareContext } from "../../src/fsm/types.js";
import { assign } from "../../src/fsm/updater.js";
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
    // the transition payload's `next`. Since 0.6.0 a send() from a listener is
    // queued (run-to-completion), so the outer payload can no longer be
    // overtaken; this pins that each payload still references its own outcome.
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
    // Order: outer emits red->green; the inner send queued inside that
    // handler then runs its own full sequence and emits green->yellow. Both
    // payloads reference their own outcomes, not reordered or aliased.
    expect(events).toEqual(["red->green", "green->yellow"]);
  });

  it("reset() 'transition' payload is captured pre-reentry (FSM-B-01 / FSM-T-03)", () => {
    // Mirror of the send() re-entrancy regression above, but with reset() as
    // the OUTER call. reset() once ran notify() (which fires subscribe
    // listeners) before reading the live `snapshot` for the 'transition'
    // payload, so a subscriber's send() leaked into reset's `next`. The send()
    // is now queued behind the reset's own notifications (aifsmjs-3).
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
        runtime.send({ type: "NEXT" }); // red -> green, queued behind the reset
      }
    });

    runtime.reset();
    unsub();

    // The reset genuinely went green -> red; its emitted payload must say so,
    // not "green->green" (aliasing the re-entry's outcome into next).
    expect(resetPayloads).toEqual(["green->red"]);
    // And the live snapshot reflects the queued send that ran last.
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

  it("dispose() never rethrows a throwing 'dispose' listener and still completes teardown (C1)", () => {
    // Regression: emit('dispose') fired BEFORE the eventListeners sets were
    // cleared and before externalAbortCleanups ran, and emit() had no
    // per-listener try/catch. A throwing 'dispose' listener therefore escaped
    // dispose() (violating the never-throws/idempotent contract: README:65,
    // STABILITY.md:22, runtime.ts:34) AND aborted the rest of teardown, so the
    // external-signal abort listener leaked and a second dispose() short-
    // circuited on `if (disposed) return` without ever cleaning it up.
    const runtime = createRuntime(trafficLight, makeImpl());

    // External signal whose abort listener MUST be detached during dispose().
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    runtime.on("transition", vi.fn(), { signal: ac.signal });

    // A 'dispose' listener that throws.
    const disposeListener = vi.fn(() => {
      throw new Error("dispose-listener-boom");
    });
    runtime.on("dispose", disposeListener);

    // 1. dispose() must NOT rethrow the listener error (never-throws contract).
    expect(() => runtime.dispose()).not.toThrow();
    expect(disposeListener).toHaveBeenCalledTimes(1);

    // 2. Teardown must still complete despite the throw: the external-signal
    //    abort listener was detached (no leak).
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // 3. A second dispose() is idempotent: no re-emit, no throw.
    expect(() => runtime.dispose()).not.toThrow();
    expect(disposeListener).toHaveBeenCalledTimes(1);

    // 4. Listener sets were cleared, so aborting the external signal now is a
    //    harmless no-op (the listener can't fire post-dispose).
    expect(() => ac.abort()).not.toThrow();
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

  it("emit() skips a transition listener removed mid-dispatch (ai*js fan-out rule, 0.6.0)", () => {
    // 0.6.0 contract (replaces the 0.5.x FAM-S-03 pin where B still fired):
    // the dispatch keeps iterating its pre-taken snapshot but skips an entry
    // removed meanwhile. Listener A unsubscribes B; B must NOT fire this round.
    const runtime = createRuntime(trafficLight, makeImpl());
    const order: string[] = [];
    runtime.on("transition", () => {
      order.push("A");
      offB(); // remove B mid-dispatch
    });
    const offB = runtime.on("transition", () => {
      order.push("B");
    });
    runtime.send({ type: "NEXT" });
    expect(order).toEqual(["A"]);
    order.length = 0;
    runtime.send({ type: "NEXT" });
    expect(order).toEqual(["A"]);
  });

  it("emit() skips listeners removed by a signal abort or dispose() mid-dispatch", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    const order: string[] = [];
    runtime.on("transition", () => {
      order.push("A");
      ac.abort();
    });
    runtime.on("transition", () => order.push("B"), { signal: ac.signal });
    runtime.on("transition", () => {
      order.push("C");
      runtime.dispose();
    });
    runtime.on("transition", () => order.push("D"));
    runtime.send({ type: "NEXT" });
    expect(order).toEqual(["A", "C"]);
  });

  it("a once-listener goes inert before its first call: a send() from inside it cannot re-fire it", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const calls: string[] = [];
    runtime.on(
      "transition",
      (e) => {
        calls.push(`once:${e.next.value}`);
        runtime.send({ type: "NEXT" });
      },
      { once: true },
    );
    runtime.on("transition", (e) => calls.push(e.next.value));
    runtime.send({ type: "NEXT" });
    expect(calls).toEqual(["once:green", "green", "yellow"]);
  });

  it("emit() snapshot: a listener added during dispatch does not fire this round (FAM-S-03)", () => {
    const runtime = createRuntime(trafficLight, makeImpl());
    const order: string[] = [];
    runtime.on("transition", () => {
      order.push("A");
      // Add C mid-dispatch — must NOT fire for the current event.
      runtime.on("transition", () => order.push("C"));
    });
    runtime.send({ type: "NEXT" }); // red -> green
    expect(order).toEqual(["A"]);
    order.length = 0;
    runtime.send({ type: "NEXT" }); // green -> yellow: A and the added C both fire
    expect(order).toEqual(["A", "C"]);
  });

  it("subscribe() skips a listener removed mid-dispatch; one added waits for the next event", () => {
    // Same 0.6.0 fan-out rule for the subscribe() channel.
    const runtime = createRuntime(trafficLight, makeImpl());
    const order: string[] = [];
    runtime.subscribe(() => {
      order.push("A");
      offB();
      runtime.subscribe(() => order.push("C"));
    });
    const offB = runtime.subscribe(() => {
      order.push("B");
    });
    runtime.send({ type: "NEXT" });
    expect(order).toEqual(["A"]);
    order.length = 0;
    runtime.send({ type: "NEXT" });
    expect(order[0]).toBe("A");
    expect(order).toContain("C");
    expect(order).not.toContain("B");
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

describe("runtime — Object.prototype keys are not declared (aifsmjs-1)", () => {
  const machine = defineMachine<{ n: number }, { type: string }, "a" | "b">({
    id: "proto-rt",
    initial: "a",
    context: { n: 0 },
    states: { a: { on: { GO: { target: "b", actions: ["fx"] } } }, b: {} },
  });

  it("send({ type: 'constructor' }) neither notifies nor emits 'transition'", () => {
    const runtime = createRuntime(machine, { actions: { fx: () => {} } });
    const seen: string[] = [];
    runtime.subscribe((s) => seen.push(s.value));
    runtime.on("transition", () => seen.push("transition"));
    runtime.send({ type: "constructor" });
    expect(seen).toEqual([]);
  });

  it("can({ type: 'toString' }) is false", () => {
    expect(createRuntime(machine, {}).can({ type: "toString" })).toBe(false);
  });

  it("an effect typed 'valueOf' with no own handler is skipped", () => {
    const runtime = createRuntime(machine, {
      actions: { fx: ({ enqueue }) => enqueue.effect("valueOf") },
      effects: {},
    });
    expect(() => runtime.send({ type: "GO" })).not.toThrow();
    expect(runtime.getSnapshot().value).toBe("b");
  });
});

describe("runtime events — per-listener isolation (aifsmjs-6)", () => {
  type ECtx = { n: number };
  type EEvt = { type: "GO" };
  const machine = defineMachine<ECtx, EEvt, "a" | "b">({
    id: "emit",
    initial: "a",
    context: { n: 0 },
    states: { a: { on: { GO: { target: "b", actions: ["fx"] } } }, b: {} },
  });

  it("a throwing 'dispose' listener does not prevent later 'dispose' listeners", () => {
    const runtime = createRuntime(machine, {});
    const calls: string[] = [];
    runtime.on("dispose", () => {
      calls.push("first");
      throw new Error("boom");
    });
    runtime.on("dispose", () => calls.push("second"));
    expect(() => runtime.dispose()).not.toThrow();
    expect(calls).toEqual(["first", "second"]);
  });

  it("a throwing 'error' listener does not skip later ones; its error still surfaces", async () => {
    const runtime = createRuntime(machine, {
      actions: {
        fx: ({ enqueue }) => {
          enqueue.effect("boomAsync");
        },
      },
      effects: {
        boomAsync: async () => {
          throw new Error("effect-rejected");
        },
      },
    });
    const calls: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      runtime.on("error", () => {
        calls.push("first");
        throw new Error("listener-threw");
      });
      runtime.on("error", () => calls.push("second"));
      runtime.send({ type: "GO" });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(calls).toEqual(["first", "second"]);
    expect((unhandled[0] as Error).message).toBe("listener-threw");
  });

  it("throwing 'transition' listeners still let later ones run before send() rethrows the first", () => {
    const runtime = createRuntime(machine, { actions: { fx: () => {} } });
    const calls: string[] = [];
    runtime.on("transition", () => {
      calls.push("first");
      throw new Error("t-boom");
    });
    runtime.on("transition", () => {
      calls.push("second");
      throw new Error("t-boom-2");
    });
    runtime.on("transition", () => calls.push("third"));
    // The first error wins; later listeners still run.
    expect(() => runtime.send({ type: "GO" })).toThrow("t-boom");
    expect(calls).toEqual(["first", "second", "third"]);
    expect(runtime.getSnapshot().value).toBe("b");
  });
});

describe("reset() change detection includes status and context (aifsmjs-7)", () => {
  type C = { n: number };
  type E = { type: "INC" };
  const machine = defineMachine<C, E, "a" | "b">({
    id: "reset-ctx",
    initial: "a",
    context: { n: 0 },
    // INC is internal: the value stays "a", only the context changes.
    states: { a: { on: { INC: { actions: ["inc"] } } }, b: {} },
  });
  const impl: Implementations<C, E> = {
    actions: { inc: assign(({ context }) => ({ n: context.n + 1 })) },
  };

  it("same value + a different context reference notifies subscribers, middleware and 'transition'", () => {
    const changedFlags: boolean[] = [];
    const rt = createRuntime(machine, impl, {
      middleware: [
        (mw, next) => {
          changedFlags.push(mw.changed);
          next();
        },
      ],
    });
    rt.send({ type: "INC" });
    changedFlags.length = 0;
    const seen: number[] = [];
    const transitions: number[] = [];
    rt.subscribe((snap) => seen.push(snap.context.n));
    rt.on("transition", (e) => transitions.push(e.next.context.n));
    const after = rt.reset();
    expect(after.value).toBe("a");
    expect(after.context).toBe(machine.context);
    expect(seen).toEqual([0]);
    expect(transitions).toEqual([0]);
    expect(changedFlags).toEqual([true]);
  });

  it("same value + the same context reference stays silent", () => {
    const changedFlags: boolean[] = [];
    const rt = createRuntime(machine, impl, {
      middleware: [
        (mw, next) => {
          changedFlags.push(mw.changed);
          next();
        },
      ],
    });
    const fn = vi.fn();
    rt.subscribe(fn);
    rt.on("transition", fn);
    rt.reset();
    expect(fn).not.toHaveBeenCalled();
    expect(changedFlags).toEqual([false]);
  });
});

describe("middleware never freezes the caller's event (aifsmjs-4)", () => {
  type C = { n: number };
  type E = { type: "GO"; payload: { items: number[] } };
  const machine = defineMachine<C, E, "a" | "b">({
    id: "mw-event",
    initial: "a",
    context: { n: 0 },
    states: { a: { on: { GO: "b" } }, b: {} },
  });

  it("dev: the event and its nested payload stay mutable; middleware sees the same object", () => {
    let seen: MiddlewareContext<C, E, "a" | "b">["event"] | undefined;
    const rt = createRuntime(
      machine,
      {},
      {
        middleware: [
          (mw, next) => {
            seen = mw.event;
            expect(Object.isFrozen(mw)).toBe(true);
            next();
          },
        ],
      },
    );
    const event: E = { type: "GO", payload: { items: [1] } };
    rt.send(event);
    expect(seen).toBe(event);
    expect(Object.isFrozen(event)).toBe(false);
    expect(Object.isExtensible(event.payload)).toBe(true);
    event.payload.items.push(2);
    expect(event.payload.items).toEqual([1, 2]);
  });

  it("production: the event is not frozen either", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      const fresh = await import("../../src/fsm/runtime.js");
      const rt = fresh.createRuntime(machine, {}, { middleware: [(_mw, next) => next()] });
      const event: E = { type: "GO", payload: { items: [1] } };
      rt.send(event);
      expect(rt.getSnapshot().value).toBe("b");
      expect(Object.isFrozen(event)).toBe(false);
      expect(Object.isExtensible(event.payload)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("argument validation at the runtime boundary (InvalidDefinitionError)", () => {
  const def = trafficLight;
  // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse from untyped callers
  const loose = (v: unknown): any => v;

  it("createRuntime rejects a non-object definition, states, implementations or options", () => {
    expect(() => createRuntime(loose(undefined), {})).toThrow(InvalidDefinitionError);
    expect(() => createRuntime(loose(undefined), {})).toThrow(
      /^aifsmjs: definition must be an object$/,
    );
    expect(() => createRuntime(loose({ id: "x", initial: "a" }), {})).toThrow(
      /aifsmjs: definition states must be an object/,
    );
    expect(() => createRuntime(def, loose(undefined))).toThrow(
      /aifsmjs: implementations must be an object/,
    );
    expect(() => createRuntime(def, makeImpl(), loose(null))).toThrow(
      /aifsmjs: options must be an object/,
    );
  });

  it("createRuntime rejects a middleware option that is not an array of functions", () => {
    for (const middleware of [loose({}), loose([5]), loose([() => {}, "x"])]) {
      expect(() => createRuntime(def, makeImpl(), { middleware })).toThrow(
        /aifsmjs: options\.middleware must be an array of functions/,
      );
    }
  });

  it("send()/reset() reject an event that is not an object with a string type", () => {
    const rt = createRuntime(def, makeImpl());
    const seen = vi.fn();
    rt.subscribe(seen);
    for (const bad of [undefined, null, 5, "NEXT", { type: 1 }]) {
      expect(() => rt.send(loose(bad))).toThrow(InvalidDefinitionError);
    }
    expect(() => rt.send(loose(undefined))).toThrow(
      /aifsmjs: send\(\) event must be an object with a string type/,
    );
    expect(() => rt.reset(loose(5))).toThrow(/aifsmjs: reset\(\) event must be an object/);
    expect(() => rt.reset()).not.toThrow();
    expect(seen).not.toHaveBeenCalled();
    expect(rt.getSnapshot().value).toBe("red");
  });

  it("a nested send() with a bad event throws at the call instead of poisoning the mailbox", () => {
    const rt = createRuntime(def, makeImpl());
    let thrown: unknown;
    rt.subscribe(() => {
      try {
        rt.send(loose(null));
      } catch (err) {
        thrown = err;
      }
    });
    expect(rt.send({ type: "NEXT" }).value).toBe("green");
    expect(thrown).toBeInstanceOf(InvalidDefinitionError);
  });

  it("subscribe()/on()/onTransition() reject a non-function listener and an unknown event type", () => {
    const rt = createRuntime(def, makeImpl());
    expect(() => rt.subscribe(loose(5))).toThrow(/aifsmjs: listener must be a function/);
    expect(() => rt.on("transition", loose(undefined))).toThrow(
      /aifsmjs: listener must be a function/,
    );
    expect(() => rt.onTransition(loose("x"))).toThrow(InvalidDefinitionError);
    expect(() => rt.on(loose("bogus"), () => {})).toThrow(
      /aifsmjs: on\(\) type must be "transition", "error" or "dispose"/,
    );
    expect(() => rt.on(loose("toString"), () => {})).toThrow(InvalidDefinitionError);
    // Nothing was registered: a transition still runs cleanly.
    expect(rt.send({ type: "NEXT" }).value).toBe("green");
  });

  it("error.name equals the class name", () => {
    try {
      createRuntime(def, loose(undefined));
    } catch (err) {
      expect((err as Error).name).toBe("InvalidDefinitionError");
    }
  });
});

describe("async effect rejection with no 'error' listener (aifsmjs-14)", () => {
  type C = { n: number };
  type E = { type: "GO" };
  const machine = defineMachine<C, E, "a" | "b">({
    id: "warn",
    initial: "a",
    context: { n: 0 },
    states: { a: { on: { GO: { target: "b", actions: ["fx"] } } }, b: {} },
  });
  const rejecting: Implementations<C, E> = {
    actions: { fx: ({ enqueue }) => enqueue.effect("boom") },
    effects: {
      boom: async () => {
        throw new Error("async-boom");
      },
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("dev: warns once via console.warn when no 'error' listener is registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = createRuntime(machine, rejecting);
    rt.send({ type: "GO" });
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^aifsmjs: unhandled async effect rejection/);
    expect((warn.mock.calls[0]?.[1] as Error).message).toBe("async-boom");
  });

  it("no warning once an 'error' listener exists; the listener gets the rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = createRuntime(machine, rejecting);
    const errors: unknown[] = [];
    rt.on("error", (e) => errors.push(e.error));
    rt.send({ type: "GO" });
    await flush();
    expect(warn).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it("a rejection after dispose() (listeners cleared) warns and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const rt = createRuntime(machine, {
        actions: { fx: ({ enqueue }) => enqueue.effect("wait") },
        effects: {
          wait: (_eff, { signal }) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        },
      });
      rt.on("error", () => {});
      rt.send({ type: "GO" });
      expect(() => rt.dispose()).not.toThrow();
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it("production: the rejection is discarded silently", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fresh = await import("../../src/fsm/runtime.js");
      const rt = fresh.createRuntime(machine, rejecting);
      rt.send({ type: "GO" });
      await flush();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
