import { describe, expect, it } from "vitest";
import { defineMachine, initialSnapshot } from "../../src/fsm/definition.js";
import { UnknownGuardError } from "../../src/fsm/evaluator.js";
import { InvalidActionResultError, UnknownActionError, step } from "../../src/fsm/lifecycle.js";
import { resolveTransitions } from "../../src/fsm/resolver.js";
import { createRuntime } from "../../src/fsm/runtime.js";
import type { Implementations } from "../../src/fsm/types.js";
import { assign } from "../../src/fsm/updater.js";
import { type Ctx, type Evt, makeImpl, trafficLight } from "../fixtures/traffic-light.js";

describe("step — happy path", () => {
  it("transitions red → green with bump + notify effect", () => {
    const impl = makeImpl();
    const initial = initialSnapshot(trafficLight);
    const r = step(trafficLight, initial, { type: "NEXT" }, impl);
    expect(r.changed).toBe(true);
    expect(r.snapshot.value).toBe("green");
    expect(r.snapshot.context.ticks).toBe(1);
    // notify + entry of red was already applied at definition? No — entry is
    // only on enter (target). red is initial state — its entry does not run
    // through step(). But we transitioned out of red into green, so red has
    // no exit and green has no entry — only the transition actions ran.
    const types = r.effects.map((e) => e.type);
    expect(types).toContain("trackTransition");
  });

  it("runs entry actions when entering halt", () => {
    const impl = makeImpl();
    const r = step(trafficLight, initialSnapshot(trafficLight), { type: "EMERGENCY" }, impl);
    expect(r.snapshot.value).toBe("halt");
    expect(r.effects.some((e) => e.type === "logEnter")).toBe(true);
  });

  it("returns same snapshot when event has no matching transition", () => {
    const impl = makeImpl();
    const initial = initialSnapshot(trafficLight);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately unknown event
    const r = step(trafficLight, initial, { type: "GHOST" } as any, impl);
    expect(r.changed).toBe(false);
    expect(r.snapshot).toBe(initial);
    expect(r.effects).toEqual([]);
  });

  it("evaluates guard fallback (yellow → green when ticksOdd false)", () => {
    const impl = makeImpl();
    let snap = initialSnapshot(trafficLight); // red, ticks=0
    snap = step(trafficLight, snap, { type: "NEXT" }, impl).snapshot; // green, ticks=1
    snap = step(trafficLight, snap, { type: "NEXT" }, impl).snapshot; // yellow, ticks=2
    // ticks=2 → ticksOdd=false → fallback to green
    const r = step(trafficLight, snap, { type: "NEXT" }, impl);
    expect(r.snapshot.value).toBe("green");
  });

  it("evaluates guard pass (yellow → red when ticksOdd true)", () => {
    // Force ticksOdd to true so the first yellow candidate wins.
    const impl: Implementations<Ctx, Evt> = {
      ...makeImpl(),
      guards: { ticksOdd: () => true },
    };
    let snap = initialSnapshot(trafficLight); // red
    snap = step(trafficLight, snap, { type: "NEXT" }, impl).snapshot; // green
    snap = step(trafficLight, snap, { type: "NEXT" }, impl).snapshot; // yellow
    const r = step(trafficLight, snap, { type: "NEXT" }, impl);
    expect(r.snapshot.value).toBe("red");
  });

  it("runs multiple transition actions in declaration order", () => {
    const order: string[] = [];
    type C = { tag: string };
    type E = { type: "GO" };
    const def = defineMachine<C, E, "a" | "b">({
      id: "m",
      initial: "a",
      context: { tag: "init" },
      states: {
        a: { on: { GO: { target: "b", actions: ["first", "second", "third"] } } },
        b: {},
      },
    });
    const impl: Implementations<C, E> = {
      actions: {
        first: () => {
          order.push("first");
        },
        second: () => {
          order.push("second");
        },
        third: () => {
          order.push("third");
        },
      },
    };
    step(def, initialSnapshot(def), { type: "GO" }, impl);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("does not run exit/entry on internal transition (no target)", () => {
    const calls: string[] = [];
    type C = { n: number };
    type E = { type: "TICK" };
    const def = defineMachine<C, E, "a">({
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          entry: ["onEntry"],
          exit: ["onExit"],
          on: { TICK: { actions: ["onTick"] } },
        },
      },
    });
    const impl: Implementations<C, E> = {
      actions: {
        onEntry: () => {
          calls.push("entry");
        },
        onExit: () => {
          calls.push("exit");
        },
        onTick: () => {
          calls.push("tick");
        },
      },
    };
    step(def, initialSnapshot(def), { type: "TICK" }, impl);
    expect(calls).toEqual(["tick"]);
  });

  it("runs exit then transition action then entry on external transition", () => {
    const calls: string[] = [];
    type C = { n: number };
    type E = { type: "GO" };
    const def = defineMachine<C, E, "a" | "b">({
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          exit: ["onExitA"],
          on: { GO: { target: "b", actions: ["onTransition"] } },
        },
        b: { entry: ["onEntryB"] },
      },
    });
    const impl: Implementations<C, E> = {
      actions: {
        onExitA: () => {
          calls.push("exitA");
        },
        onTransition: () => {
          calls.push("transition");
        },
        onEntryB: () => {
          calls.push("entryB");
        },
      },
    };
    step(def, initialSnapshot(def), { type: "GO" }, impl);
    expect(calls).toEqual(["exitA", "transition", "entryB"]);
  });

  it("throws UnknownActionError for missing action ref", () => {
    type C = { n: number };
    type E = { type: "GO" };
    const def = defineMachine<C, E, "a" | "b">({
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: {
        a: { on: { GO: { target: "b", actions: ["ghost"] } } },
        b: {},
      },
    });
    expect(() => step(def, initialSnapshot(def), { type: "GO" }, {})).toThrow(UnknownActionError);
  });

  it("is pure: does not mutate inputs", () => {
    const impl = makeImpl();
    const initial = initialSnapshot(trafficLight);
    const ctxBefore = JSON.stringify(initial.context);
    step(trafficLight, initial, { type: "NEXT" }, impl);
    expect(JSON.stringify(initial.context)).toBe(ctxBefore);
  });

  it("does not run transitions in final state", () => {
    type C = { x: number };
    type E = { type: "GO" };
    const def = defineMachine<C, E, "done">({
      id: "m",
      initial: "done",
      context: { x: 1 },
      states: { done: { final: true } },
    });
    const initial = initialSnapshot(def);
    const r = step(def, initial, { type: "GO" }, { actions: {} });
    expect(r.changed).toBe(false);
    expect(r.snapshot).toBe(initial);
  });

  it("marks status='final' when transitioning into a final state", () => {
    type C = Record<string, never>;
    type E = { type: "FINISH" };
    const def = defineMachine<C, E, "a" | "b">({
      id: "m",
      initial: "a",
      context: {},
      states: {
        a: { on: { FINISH: { target: "b" } } },
        b: { final: true },
      },
    });
    const r = step(def, initialSnapshot(def), { type: "FINISH" }, {});
    expect(r.snapshot.value).toBe("b");
    expect(r.snapshot.status).toBe("final");
  });

  it("supports inline action functions", () => {
    type C = { n: number };
    type E = { type: "GO" };
    const def = defineMachine<C, E, "a" | "b">({
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          on: {
            GO: {
              target: "b",
              actions: [assign(({ context }) => ({ n: context.n + 5 }))],
            },
          },
        },
        b: {},
      },
    });
    const r = step(def, initialSnapshot(def), { type: "GO" }, {});
    expect(r.snapshot.context.n).toBe(5);
  });

  it("returns frozen snapshot", () => {
    const impl = makeImpl();
    const r = step(trafficLight, initialSnapshot(trafficLight), { type: "NEXT" }, impl);
    expect(Object.isFrozen(r.snapshot)).toBe(true);
  });
});

describe("step — Object.prototype keys are not declared (aifsmjs-1)", () => {
  type PCtx = { n: number };
  type PEvt = { type: string };
  const PROTO_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];
  const machine = defineMachine<PCtx, PEvt, "a" | "b">({
    id: "proto",
    initial: "a",
    context: { n: 0 },
    states: { a: { on: { GO: { target: "b" } } }, b: {} },
  });

  it.each(PROTO_KEYS)("undeclared event type %s is a no-op", (type) => {
    const initial = initialSnapshot(machine);
    const r = step(machine, initial, { type }, {});
    expect(r.changed).toBe(false);
    expect(r.snapshot).toBe(initial);
    expect(r.effects).toEqual([]);
  });

  it("guard ref 'constructor' throws UnknownGuardError", () => {
    const g = defineMachine<PCtx, PEvt, "a" | "b">({
      id: "proto-guard",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { GO: { target: "b", guard: "constructor" } } }, b: {} },
    });
    expect(() => step(g, initialSnapshot(g), { type: "GO" }, { guards: {} })).toThrow(
      UnknownGuardError,
    );
  });

  it("action ref 'toString' throws UnknownActionError", () => {
    const a = defineMachine<PCtx, PEvt, "a" | "b">({
      id: "proto-action",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { GO: { target: "b", actions: ["toString"] } } }, b: {} },
    });
    expect(() => step(a, initialSnapshot(a), { type: "GO" }, { actions: {} })).toThrow(
      UnknownActionError,
    );
  });

  it("resolveTransitions ignores inherited keys", () => {
    expect(resolveTransitions(machine, "a", "toString")).toEqual([]);
  });
});

describe("guards run once per event (aifsmjs-9)", () => {
  type C = { n: number };
  type E = { type: "SELF" } | { type: "TICK" };
  const machine = defineMachine<C, E, "a" | "b">({
    id: "guard-count",
    initial: "a",
    context: { n: 0 },
    states: {
      a: {
        on: {
          // Same-value external transition (self-target) and an internal one.
          SELF: { target: "a", guard: "counted" },
          TICK: { guard: "counted", actions: ["inc"] },
        },
      },
      b: {},
    },
  });

  it("send() evaluates the chosen guard exactly once for a same-value external transition", () => {
    let calls = 0;
    const rt = createRuntime(machine, {
      guards: {
        counted: () => {
          calls += 1;
          return true;
        },
      },
    });
    rt.send({ type: "SELF" });
    expect(calls).toBe(1);
  });

  it("send() evaluates the chosen guard exactly once for an internal transition", () => {
    let calls = 0;
    const rt = createRuntime(machine, {
      guards: {
        counted: () => {
          calls += 1;
          return true;
        },
      },
      actions: { inc: ({ context }) => ({ n: context.n + 1 }) },
    });
    rt.send({ type: "TICK" });
    expect(calls).toBe(1);
    expect(rt.getSnapshot().context.n).toBe(1);
  });

  it("a non-idempotent guard cannot desync the sub lifecycle from the committed snapshot", () => {
    // First evaluation passes (self-target, replaces the child); a second pass
    // would fail. The child must be replaced exactly when step() chose SELF.
    const sub = defineMachine({ id: "kid", initial: "k", states: { k: {} } });
    const withSub = defineMachine<C, E, "a" | "b">({
      id: "guard-sub",
      initial: "a",
      context: { n: 0 },
      states: { a: { sub, on: { SELF: { target: "a", guard: "once" } } }, b: {} },
    });
    let first = true;
    const rt = createRuntime(withSub, {
      guards: {
        once: () => {
          const r = first;
          first = false;
          return r;
        },
      },
    });
    const before = rt.subRuntime();
    rt.send({ type: "SELF" });
    expect(rt.subRuntime()).not.toBe(before);
    expect(before?.disposed).toBe(true);
  });
});

describe("InvalidActionResultError (aifsmjs-11)", () => {
  type C = { n: number };
  type E = { type: "GO" };
  const machine = (actions: unknown[]) =>
    defineMachine<C, E, "a" | "b">({
      id: "bad-patch",
      initial: "a",
      context: { n: 0 },
      // biome-ignore lint/suspicious/noExplicitAny: action refs of mixed kinds
      states: { a: { on: { GO: { target: "b", actions: actions as any } } }, b: {} },
    });

  it("a false / 0 patch on an object context throws from step(); the name is the string ref", () => {
    // biome-ignore lint/suspicious/noExplicitAny: an action returning a primitive
    const impl = { actions: { flag: (() => false) as any, zero: (() => 0) as any } };
    const def = machine(["flag"]);
    const snap = initialSnapshot(def);
    let thrown: unknown;
    try {
      step(def, snap, { type: "GO" }, impl);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvalidActionResultError);
    expect((thrown as InvalidActionResultError).actionName).toBe("flag");
    expect((thrown as Error).name).toBe("InvalidActionResultError");
    expect((thrown as Error).message).toBe(
      'aifsmjs: action "flag" returned boolean; an object context accepts only a plain-object patch (or undefined)',
    );
    expect(() => step(machine(["zero"]), snap, { type: "GO" }, impl)).toThrow(/returned number/);
  });

  it("inline actions report their function name, or <inline> when anonymous", () => {
    function namedFlag() {
      return false;
    }
    const snap = initialSnapshot(machine([namedFlag]));
    expect(() => step(machine([namedFlag]), snap, { type: "GO" }, {})).toThrow(
      /action "namedFlag" returned boolean/,
    );
    expect(() => step(machine([[() => ""][0]]), snap, { type: "GO" }, {})).toThrow(
      /action "<inline>" returned string/,
    );
  });

  it("send() throws before commit: the snapshot and subscribers are untouched", () => {
    const rt = createRuntime(machine([() => false]), {});
    const seen: string[] = [];
    rt.subscribe((s) => seen.push(s.value));
    expect(() => rt.send({ type: "GO" })).toThrow(InvalidActionResultError);
    expect(rt.getSnapshot().value).toBe("a");
    expect(seen).toEqual([]);
  });
});
