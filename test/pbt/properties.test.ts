import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { defineMachine } from "../../src/fsm/definition.js";
import type { Implementations } from "../../src/fsm/types.js";
import { assign } from "../../src/fsm/updater.js";
import {
  assertAll,
  assignDoesNotMutate,
  contextEquals,
  guardsFalseNoTransition,
  reachableStatesSubsetDeclared,
  replayEqualsFold,
  snapshotAlwaysFrozen,
  unknownEventNoOp,
} from "../../src/pbt/properties.js";
import { type EffectLog, type Evt, makeImpl, trafficLight } from "../fixtures/traffic-light.js";

const eventArbs = {
  NEXT: fc.constant({ type: "NEXT" } as Evt),
  EMERGENCY: fc.constant({ type: "EMERGENCY" } as Evt),
  RESET: fc.constant({ type: "RESET" } as Evt),
};

describe("PBT generic properties — traffic-light fixture", () => {
  it("#1 snapshotAlwaysFrozen", () => {
    snapshotAlwaysFrozen(trafficLight, makeImpl(), eventArbs, { numRuns: 50 });
  });

  it("#2 unknownEventNoOp", () => {
    unknownEventNoOp(trafficLight, makeImpl(), "__UNKNOWN__", { numRuns: 50 });
  });

  it("#3 reachableStatesSubsetDeclared", () => {
    reachableStatesSubsetDeclared(trafficLight, makeImpl(), eventArbs, { numRuns: 50 });
  });

  it("#4 replayEqualsFold", () => {
    replayEqualsFold(trafficLight, makeImpl(), eventArbs, { numRuns: 50 });
  });

  it("#5 guardsFalseNoTransition", () => {
    guardsFalseNoTransition(trafficLight, makeImpl(), eventArbs, { numRuns: 50 });
  });

  it("#6 assignDoesNotMutate", () => {
    assignDoesNotMutate(trafficLight, makeImpl(), eventArbs, { numRuns: 50 });
  });

  it("assertAll convenience runner", () => {
    assertAll(trafficLight, makeImpl(), eventArbs, { numRuns: 25 });
  });

  it("snapshotAlwaysFrozen and reachableStatesSubsetDeclared never dispatch effects (aifsmjs-16)", () => {
    const log: EffectLog = [];
    snapshotAlwaysFrozen(trafficLight, makeImpl(log), eventArbs, { numRuns: 25 });
    reachableStatesSubsetDeclared(trafficLight, makeImpl(log), eventArbs, { numRuns: 25 });
    expect(log).toEqual([]);
  });

  it("snapshotAlwaysFrozen / reachableStatesSubsetDeclared / replayEqualsFold dispose each run's runtime (aifsmjs-16)", () => {
    // Effects are not dispatched in these properties, so observe the runtime's
    // own AbortController: dispose() aborts it exactly once per generated run.
    const abort = vi.spyOn(AbortController.prototype, "abort");
    snapshotAlwaysFrozen(trafficLight, makeImpl(), eventArbs, { numRuns: 7 });
    expect(abort).toHaveBeenCalledTimes(7);
    reachableStatesSubsetDeclared(trafficLight, makeImpl(), eventArbs, { numRuns: 5 });
    expect(abort).toHaveBeenCalledTimes(12);
    replayEqualsFold(trafficLight, makeImpl(), eventArbs, { numRuns: 4 });
    expect(abort).toHaveBeenCalledTimes(16);
  });

  it("a run's runtime is disposed even when the property throws", () => {
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const boom = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "pbt-throw",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { GO: { target: "b", actions: ["missing"] } } }, b: {} },
    });
    // A single run can draw an empty event array and never reach the throwing
    // action; 20 runs under a fixed seed make the throw deterministic.
    expect(() =>
      replayEqualsFold(
        boom,
        {},
        { GO: fc.constant({ type: "GO" as const }) },
        { numRuns: 20, seed: 1 },
      ),
    ).toThrow();
    expect(abort).toHaveBeenCalled();
  });

  it("opts honour seed and verbose flags", () => {
    snapshotAlwaysFrozen(trafficLight, makeImpl(), eventArbs, {
      numRuns: 5,
      seed: 42,
      verbose: true,
    });
  });
});

// ---------------------------------------------------------------------------
// FSM-B-02 — guardsFalseNoTransition must be non-vacuous: when a fully-guarded
// (state,event) still transitions, the property MUST fail. The old body
// returned `true` unconditionally, so it could only fail if step() threw.
//
// Witness seam: the property forces *string-ref* guards false via a proxy over
// impl.guards, but an INLINE guard written directly in the definition is not
// looked up there, so it keeps returning true. Such a transition is
// fully-guarded (it carries a `guard`) yet fires — exactly the violation the
// strengthened assertion catches and the vacuous body missed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C3 — context equality must be a STRUCTURAL deep-equal, not JSON.stringify.
//
// The replayEqualsFold / assignDoesNotMutate oracles compared context with
// `JSON.stringify(a) === JSON.stringify(b)`, which is:
//   - key-order-sensitive  → FALSE-FAIL on {a:1,b:2} vs {b:2,a:1}
//   - drops undefined keys  → FALSE-PASS on {v:undefined,w:1} vs {w:1}
//   - lossy for Map/Set/Date, throws on BigInt.
// contextEquals (backed by node:util isDeepStrictEqual) must give the correct
// verdict in every case.
// ---------------------------------------------------------------------------
describe("contextEquals — structural deep-equal replaces JSON.stringify oracle (C3)", () => {
  // The old oracle, reproduced verbatim so the test pins exactly what it got wrong.
  const jsonOracle = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  it("key-order: JSON oracle FALSE-FAILS on reordered keys; contextEquals is correct", () => {
    const a = { a: 1, b: 2 };
    const b = { b: 2, a: 1 };
    // Witness the defect: JSON.stringify is key-order-sensitive.
    expect(jsonOracle(a, b)).toBe(false); // false-fail — these ARE equal
    // The fix: structural equality ignores key order.
    expect(contextEquals(a, b)).toBe(true);
  });

  it("dropped undefined: JSON oracle FALSE-PASSES on {v:undefined,w:1} vs {w:1}; contextEquals is correct", () => {
    const a = { v: undefined, w: 1 };
    const b = { w: 1 };
    // Witness the defect: JSON.stringify drops undefined-valued keys.
    expect(jsonOracle(a, b)).toBe(true); // false-pass — these are NOT equal
    // The fix: a present-but-undefined key differs from an absent key.
    expect(contextEquals(a, b)).toBe(false);
  });

  it("Map/Set compared by contents (JSON renders them lossily as {})", () => {
    expect(contextEquals(new Map([["k", 1]]), new Map([["k", 1]]))).toBe(true);
    expect(contextEquals(new Map([["k", 1]]), new Map([["k", 2]]))).toBe(false);
    expect(contextEquals(new Set([1, 2]), new Set([1, 2]))).toBe(true);
    expect(contextEquals(new Set([1, 2]), new Set([1, 3]))).toBe(false);
  });

  it("Date compared by time value (JSON renders as ISO string, losing type)", () => {
    expect(contextEquals(new Date(1000), new Date(1000))).toBe(true);
    expect(contextEquals(new Date(1000), new Date(2000))).toBe(false);
  });

  it("tolerates BigInt (JSON.stringify would throw)", () => {
    expect(() => jsonOracle({ n: 1n }, { n: 1n })).toThrow(TypeError);
    expect(() => contextEquals({ n: 1n }, { n: 1n })).not.toThrow();
    expect(contextEquals({ n: 1n }, { n: 1n })).toBe(true);
    expect(contextEquals({ n: 1n }, { n: 2n })).toBe(false);
  });
});

describe("guardsFalseNoTransition is non-vacuous (FSM-B-02)", () => {
  type GCtx = { n: number };
  type GEvt = { type: "GO" };
  const goArbs = { GO: fc.constant({ type: "GO" } as GEvt) };

  it("passes when a fully-guarded transition is correctly suppressed (string-ref guard)", () => {
    const guardedMachine = defineMachine<GCtx, GEvt, "idle" | "moved">({
      id: "guarded-string",
      initial: "idle",
      context: { n: 0 },
      states: {
        idle: { on: { GO: { target: "moved", guard: "always" } } },
        moved: {},
      },
    });
    const impl: Implementations<GCtx, GEvt> = { guards: { always: () => true } };
    // String-ref guard → overridden false by the property → no transition.
    guardsFalseNoTransition(guardedMachine, impl, goArbs, { numRuns: 30 });
  });

  it("FAILS when a fully-guarded transition still fires (inline guard the proxy can't block)", () => {
    const inlineGuardMachine = defineMachine<GCtx, GEvt, "idle" | "moved">({
      id: "guarded-inline",
      initial: "idle",
      context: { n: 0 },
      states: {
        // Inline guard returns true and is NOT in impl.guards, so the
        // property's forced-false proxy cannot suppress it: idle -> moved fires
        // even though the only candidate is guarded. The strengthened property
        // must reject this; the old vacuous body accepted it (RED on HEAD).
        idle: { on: { GO: { target: "moved", guard: () => true } } },
        moved: {},
      },
    });
    expect(() =>
      guardsFalseNoTransition(inlineGuardMachine, {}, goArbs, { numRuns: 30 }),
    ).toThrow();
  });
});

describe("unknownEventNoOp — Object.prototype keys (aifsmjs-1)", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "passes for unknown type %s",
    (t) => {
      expect(() => unknownEventNoOp(trafficLight, makeImpl(), t, { numRuns: 5 })).not.toThrow();
    },
  );
});

describe("assignDoesNotMutate — non-cloneable context (aifsmjs-12)", () => {
  class Vec {
    constructor(
      public x = 0,
      public y = 0,
      public inner: { z: number } = { z: 0 },
    ) {}
  }

  it("passes for a pure machine whose context holds a class instance", () => {
    type VCtx = { pos: Vec };
    type VEvt = { type: "MOVE" };
    const def = defineMachine<VCtx, VEvt, "a">({
      id: "vec",
      initial: "a",
      context: { pos: new Vec(1, 2) },
      states: {
        a: {
          on: {
            MOVE: {
              actions: [
                assign(({ context }) => ({ pos: new Vec(context.pos.x + 1, context.pos.y) })),
              ],
            },
          },
        },
      },
    });
    const arbs = { MOVE: fc.constant({ type: "MOVE" } as VEvt) };
    expect(() => assignDoesNotMutate(def, {}, arbs, { numRuns: 10 })).not.toThrow();
  });

  it("passes for a pure machine whose context holds a callback", () => {
    type CCtx = { cb: () => void; n: number };
    type CEvt = { type: "INC" };
    const def = defineMachine<CCtx, CEvt, "a">({
      id: "cb",
      initial: "a",
      context: { cb: () => {}, n: 0 },
      states: {
        a: { on: { INC: { actions: [assign(({ context }) => ({ n: context.n + 1 }))] } } },
      },
    });
    const arbs = { INC: fc.constant({ type: "INC" } as CEvt) };
    expect(() => assignDoesNotMutate(def, {}, arbs, { numRuns: 10 })).not.toThrow();
  });

  it("still FAILS when an action mutates nested state in place", () => {
    // deepFreeze does not recurse into class instances, so `inner` stays
    // mutable even in dev and the in-place write reaches the oracle.
    type MCtx = { pos: Vec; m: Map<string, number> };
    type MEvt = { type: "BUMP" } | { type: "PUT" };
    const def = defineMachine<MCtx, MEvt, "a">({
      id: "mut",
      initial: "a",
      context: { pos: new Vec(), m: new Map() },
      states: {
        a: {
          on: {
            BUMP: {
              actions: [
                ({ context }) => {
                  context.pos.inner.z++;
                },
              ],
            },
            PUT: {
              actions: [
                ({ context }) => {
                  context.m.set("k", context.m.size);
                },
              ],
            },
          },
        },
      },
    });
    expect(() =>
      assignDoesNotMutate(
        def,
        {},
        { BUMP: fc.constant({ type: "BUMP" } as MEvt) },
        { numRuns: 10 },
      ),
    ).toThrow();
    expect(() =>
      assignDoesNotMutate(def, {}, { PUT: fc.constant({ type: "PUT" } as MEvt) }, { numRuns: 10 }),
    ).toThrow();
  });
});
