import { describe, expect, it } from "vitest";
import { defineMachine } from "../../src/fsm/definition.js";
import { UnknownActionError } from "../../src/fsm/lifecycle.js";
import { RuntimeDisposedError, createRuntime } from "../../src/fsm/runtime.js";
import type { Implementations, Runtime, Snapshot } from "../../src/fsm/types.js";
import { childImpl, childMachine } from "../fixtures/sub-machine.js";
import {
  type Ctx,
  type Evt,
  type States,
  makeImpl,
  trafficLight,
} from "../fixtures/traffic-light.js";

// aifsmjs-3 / ai*js state-owning dispatcher rule: send()/reset() are
// run-to-completion. For one event, commit -> middleware -> effects ->
// subscribe listeners -> 'transition' listeners all complete before any event
// sent from inside them is processed; nested calls are queued FIFO.

type TL = Runtime<Ctx, Evt, States>;

// Traffic light whose red->green `notify` action enqueues `trackTransition`;
// `onTrack` runs inside that effect handler with the runtime in hand.
function trafficWithEffect(onTrack: (rt: TL) => void): TL {
  const holder: { rt?: TL } = {};
  const impl = makeImpl();
  const rt = createRuntime(trafficLight, {
    ...impl,
    effects: {
      ...impl.effects,
      trackTransition: () => {
        if (holder.rt) onTrack(holder.rt);
      },
    },
  });
  holder.rt = rt;
  return rt;
}

describe("run-to-completion mailbox (aifsmjs-3)", () => {
  it("an effect handler's send() is processed after the outer event's notifications", () => {
    let fired = false;
    const rt = trafficWithEffect((r) => {
      if (fired) return;
      fired = true;
      r.send({ type: "NEXT" }); // green -> yellow, queued
    });
    const seen: string[] = [];
    const transitions: string[] = [];
    rt.subscribe((s) => seen.push(s.value));
    rt.on("transition", (e) => transitions.push(`${e.prev.value}->${e.next.value}`));

    const returned = rt.send({ type: "NEXT" }); // red -> green

    // 0.5.x delivered the inner event first ([yellow, green]), leaving
    // subscribers holding the stale "green" while the runtime sat at "yellow".
    expect(seen).toEqual(["green", "yellow"]);
    expect(transitions).toEqual(["red->green", "green->yellow"]);
    expect(rt.getSnapshot().value).toBe("yellow");
    // The outermost call returns the post-drain snapshot.
    expect(returned.value).toBe("yellow");
  });

  it("a nested send() returns the snapshot committed at the time of the call", () => {
    let nested: Snapshot<Ctx, States> | undefined;
    const rt = trafficWithEffect((r) => {
      if (nested) return;
      nested = r.send({ type: "NEXT" });
    });
    rt.send({ type: "NEXT" });
    expect(nested?.value).toBe("green"); // the outer commit, not "yellow"
    expect(rt.getSnapshot().value).toBe("yellow");
  });

  it("nested calls drain in FIFO order, each with the full sequence", () => {
    const log: string[] = [];
    const rt = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          log.push(`mw:${mw.event.type}:${mw.next.value}`);
          next();
        },
      ],
    });
    let armed = true;
    rt.subscribe((s) => {
      log.push(`sub:${s.value}`);
      if (armed) {
        armed = false;
        rt.send({ type: "EMERGENCY" }); // queued first
        rt.reset(); // queued second
      }
    });
    rt.on("transition", (e) => log.push(`tr:${e.next.value}`));
    rt.send({ type: "NEXT" });
    expect(log).toEqual([
      "mw:NEXT:green",
      "sub:green",
      "tr:green",
      "mw:EMERGENCY:halt",
      "sub:halt",
      "tr:halt",
      "mw:@@aifsmjs/RESET:red",
      "sub:red",
      "tr:red",
    ]);
    expect(rt.getSnapshot().value).toBe("red");
  });

  it("reset() from a subscriber during send() runs after every listener saw the send", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    let armed = true;
    rt.subscribe((s) => {
      if (armed && s.value === "green") {
        armed = false;
        rt.reset();
      }
    });
    const second: string[] = [];
    rt.subscribe((s) => second.push(s.value));
    const transitions: string[] = [];
    rt.on("transition", (e) => transitions.push(`${e.prev.value}->${e.next.value}`));

    rt.send({ type: "NEXT" });

    // 0.5.x ran the reset inside the first subscriber: the second one saw
    // [red, green] and ended on the stale "green".
    expect(second).toEqual(["green", "red"]);
    expect(transitions).toEqual(["red->green", "green->red"]);
    expect(rt.getSnapshot().value).toBe("red");
  });

  it("a throwing queued event discards the rest, propagates from the outermost call, and leaves the runtime usable", () => {
    type C = { n: number };
    type E = { type: "GO" } | { type: "BOOM" } | { type: "NEXT" };
    const def = defineMachine<C, E, "a" | "b" | "c" | "d">({
      id: "boom",
      initial: "a",
      context: { n: 0 },
      states: {
        a: { on: { GO: { target: "b", actions: ["fx"] } } },
        b: { on: { BOOM: { target: "c", actions: ["missing"] }, NEXT: "d" } },
        c: {},
        d: {},
      },
    });
    const holder: { rt?: Runtime<C, E, "a" | "b" | "c" | "d"> } = {};
    let caughtInHandler = false;
    const impl: Implementations<C, E> = {
      actions: { fx: ({ enqueue }) => enqueue.effect("fx") },
      effects: {
        fx: () => {
          try {
            holder.rt?.send({ type: "BOOM" }); // queued; throws later, not here
            holder.rt?.send({ type: "NEXT" }); // queued behind BOOM
          } catch {
            caughtInHandler = true;
          }
        },
      },
    };
    const rt = createRuntime(def, impl);
    holder.rt = rt;
    const seen: string[] = [];
    rt.subscribe((s) => seen.push(s.value));

    expect(() => rt.send({ type: "GO" })).toThrow(UnknownActionError);
    expect(caughtInHandler).toBe(false);
    // State stays at the last successful commit; the queued NEXT was dropped.
    expect(rt.getSnapshot().value).toBe("b");
    expect(seen).toEqual(["b"]);
    // The dispatching flag was reset: the runtime keeps working.
    expect(rt.send({ type: "NEXT" }).value).toBe("d");
    expect(seen).toEqual(["b", "d"]);
  });

  it("dispose() inside a listener runs at once, drops queued events, and the outer call returns without throwing", () => {
    const rt = trafficWithEffect((r) => {
      r.send({ type: "NEXT" }); // queued
    });
    const seen: string[] = [];
    rt.subscribe((s) => {
      seen.push(s.value);
      rt.dispose();
    });
    let returned: Snapshot<Ctx, States> | undefined;
    expect(() => {
      returned = rt.send({ type: "NEXT" });
    }).not.toThrow();
    // 0.5.x ran the effect's send() before the subscriber, reaching "yellow".
    expect(seen).toEqual(["green"]);
    expect(returned?.value).toBe("green");
    expect(rt.getSnapshot().value).toBe("green");
    expect(rt.disposed).toBe(true);
  });

  it("a nested send() on a disposed runtime still throws RuntimeDisposedError", () => {
    const rt = createRuntime(trafficLight, makeImpl());
    let thrown: unknown;
    rt.subscribe(() => {
      rt.dispose();
      try {
        rt.send({ type: "NEXT" });
      } catch (err) {
        thrown = err;
      }
    });
    rt.send({ type: "NEXT" });
    expect(thrown).toBeInstanceOf(RuntimeDisposedError);
  });

  it("a send() from middleware is queued too", () => {
    const order: string[] = [];
    const holder: { rt?: TL } = {};
    let armed = true;
    const rt = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          if (armed) {
            armed = false;
            const r = holder.rt?.send({ type: "NEXT" });
            order.push(`nested-returned:${r?.value}`);
          }
          next();
        },
      ],
    });
    holder.rt = rt;
    rt.on("transition", (e) => order.push(`${e.prev.value}->${e.next.value}`));
    rt.send({ type: "NEXT" });
    expect(order).toEqual(["nested-returned:green", "red->green", "green->yellow"]);
  });

  it("parent and child runtimes have independent mailboxes", () => {
    const parent = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "mbx-parent",
      initial: "a",
      context: { n: 0 },
      states: { a: { sub: childMachine, subImpl: childImpl, on: { GO: "b" } }, b: {} },
    });
    const rt = createRuntime(parent, {});
    const child = rt.subRuntime() as Runtime<{ hits: number }, { type: "RESOLVE" }, string>;
    const order: string[] = [];
    // A child listener that sends to the (idle) parent runs it immediately;
    // the parent's send() is not queued behind the child's dispatch.
    child.on("transition", () => {
      const r = rt.send({ type: "GO" });
      order.push(`parent-now:${r.value}`);
    });
    const childResult = child.send({ type: "RESOLVE" });
    expect(childResult.value).toBe("ready");
    expect(order).toEqual(["parent-now:b"]);
  });
});
