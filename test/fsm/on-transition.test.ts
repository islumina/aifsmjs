import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/fsm/runtime.js";
import type { RuntimeTransitionEvent } from "../../src/fsm/types.js";
import {
  makeImpl,
  type Ctx as TLCtx,
  type Evt as TLEvt,
  type States as TLStates,
  trafficLight,
} from "../fixtures/traffic-light.js";

describe("Runtime.onTransition()", () => {
  it("OT1: fires after a state-changing send; payload matches RuntimeTransitionEvent shape", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    const payloads: RuntimeTransitionEvent<TLCtx, TLEvt, TLStates>[] = [];
    rt.onTransition((p) => payloads.push(p));
    rt.send({ type: "NEXT" }); // red → green

    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.prev.value).toBe("red");
    expect(p.next.value).toBe("green");
    expect(p.changed).toBe(true);
    expect(Array.isArray(p.effects)).toBe(true);
    expect(p.event).toEqual({ type: "NEXT" });
  });

  it("OT2: does NOT fire when send causes no transition (changed === false)", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    const fired: string[] = [];
    rt.onTransition(() => fired.push("fired"));
    // Send an event that has no handler → no transition
    // biome-ignore lint/suspicious/noExplicitAny: testing no-op event
    rt.send({ type: "UNKNOWN_EVENT" } as any);
    expect(fired).toHaveLength(0);
  });

  it("OT3: fires after reset() if prev.value !== initial.value", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    rt.send({ type: "NEXT" }); // red → green
    const fired: string[] = [];
    rt.onTransition((p) => fired.push(p.next.value));
    rt.reset(); // green → red
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBe("red");
  });

  it("OT4: returned unsubscribe stops further fires", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    const fired: string[] = [];
    const unsub = rt.onTransition((p) => fired.push(p.next.value));
    rt.send({ type: "NEXT" }); // fires
    unsub();
    rt.send({ type: "NEXT" }); // should NOT fire
    expect(fired).toEqual(["green"]);
  });

  it("OT5: { once: true } fires exactly once and auto-unsubscribes", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    const fired: string[] = [];
    rt.onTransition((p) => fired.push(p.next.value), { once: true });
    rt.send({ type: "NEXT" }); // fires
    rt.send({ type: "NEXT" }); // should NOT fire
    rt.send({ type: "NEXT" }); // should NOT fire
    expect(fired).toEqual(["green"]);
  });

  it("OT6: { signal } aborts subscription when signal fires", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    const fired: string[] = [];
    const controller = new AbortController();
    rt.onTransition((p) => fired.push(p.next.value), { signal: controller.signal });
    rt.send({ type: "NEXT" }); // fires → green
    controller.abort();
    rt.send({ type: "NEXT" }); // should NOT fire
    expect(fired).toEqual(["green"]);
  });

  it("OT7: after runtime.dispose(), onTransition is a no-op and returns a no-op unsubscribe", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    rt.dispose();
    expect(() => {
      const unsub = rt.onTransition(() => {});
      expect(typeof unsub).toBe("function");
      expect(() => unsub()).not.toThrow();
    }).not.toThrow();
  });

  it("OT8: onTransition and on('transition') share the same Set — registration order determines invocation order", () => {
    // Test 1: on first then onTransition
    {
      const rt = createRuntime(trafficLight, makeImpl());
      const order: string[] = [];
      rt.on("transition", () => order.push("on-first"));
      rt.onTransition(() => order.push("onTr-second"));
      rt.send({ type: "NEXT" });
      expect(order).toEqual(["on-first", "onTr-second"]);
    }
    // Test 2: onTransition first then on
    {
      const rt = createRuntime(trafficLight, makeImpl());
      const order: string[] = [];
      rt.onTransition(() => order.push("onTr-first"));
      rt.on("transition", () => order.push("on-second"));
      rt.send({ type: "NEXT" });
      expect(order).toEqual(["onTr-first", "on-second"]);
    }
  });

  it("OT9: payload prev and next are frozen", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    let prevFrozen = false;
    let nextFrozen = false;
    rt.onTransition((p) => {
      prevFrozen = Object.isFrozen(p.prev);
      nextFrozen = Object.isFrozen(p.next);
    });
    rt.send({ type: "NEXT" });
    expect(prevFrozen).toBe(true);
    expect(nextFrozen).toBe(true);
  });

  it("OT10: handler signature accepts RuntimeTransitionEvent<Ctx, Evt, States> (compile-time check via typed handler assignment)", () => {
    // If this compiles, the type is correct.
    const rt = createRuntime(trafficLight, makeImpl());
    type TL_Transition = RuntimeTransitionEvent<TLCtx, TLEvt, TLStates>;
    const handler: (p: TL_Transition) => void = (p) => {
      // Accessing typed fields — compile error if types are wrong
      void p.prev.value;
      void p.next.context.ticks;
      void p.changed;
    };
    const unsub = rt.onTransition(handler);
    rt.send({ type: "NEXT" });
    unsub();
    // If we reach here, compile and runtime both passed
    expect(true).toBe(true);
  });

  it("OT11: onTransition(fn, { signal }) where signal is already aborted before registration → no-op", () => {
    // AbortSignal pre-abort phase: the signal is aborted BEFORE registration.
    // on() / onTransition() should detect options.signal.aborted and return a
    // no-op unsubscribe without ever adding the listener.
    const rt = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    ac.abort(); // abort BEFORE registration
    const fn = vi.fn();
    const unsub = rt.onTransition(fn, { signal: ac.signal });
    // Must return a callable no-op.
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
    // Handler must never fire regardless of subsequent transitions.
    rt.send({ type: "NEXT" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("OT12: onTransition(fn, { once: true, signal }) — once fires handler once; abort after fire is a no-op, no double-invoke", () => {
    // once+signal combination: after the first transition fires the handler
    // once, cleanup() detaches the abort listener. Aborting the signal
    // afterwards must NOT throw and must NOT invoke fn a second time.
    const rt = createRuntime(trafficLight, makeImpl());
    const ac = new AbortController();
    const fn = vi.fn();
    rt.onTransition(fn, { once: true, signal: ac.signal });

    rt.send({ type: "NEXT" }); // red → green — handler fires once
    expect(fn).toHaveBeenCalledTimes(1);

    // Abort after once-fire: teardown already happened; must be harmless.
    expect(() => ac.abort()).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1); // no double-invoke

    rt.send({ type: "NEXT" }); // green → yellow — handler must stay silent
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
