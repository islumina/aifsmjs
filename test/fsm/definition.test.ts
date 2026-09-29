import { describe, expect, expectTypeOf, it } from "vitest";
import {
  InvalidDefinitionError,
  createMachine,
  defineMachine,
  initialSnapshot,
  setup,
} from "../../src/fsm/definition.js";
import { createRuntime } from "../../src/fsm/runtime.js";
import type { MachineDef } from "../../src/fsm/types.js";
import { assign } from "../../src/fsm/updater.js";

describe("defineMachine", () => {
  it("returns the same definition object", () => {
    const def = defineMachine<Record<string, never>, { type: string }, "a" | "b">({
      id: "m",
      initial: "a",
      context: {},
      states: { a: {}, b: {} },
    });
    expect(def.id).toBe("m");
    expect(def.initial).toBe("a");
  });

  it("throws when id is missing", () => {
    expect(() =>
      defineMachine({
        id: "",
        initial: "a",
        context: {},
        states: { a: {} },
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
      } as any),
    ).toThrow(InvalidDefinitionError);
  });

  it("throws when initial is not declared", () => {
    expect(() =>
      defineMachine({
        id: "m",
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
        initial: "nope" as any,
        context: {},
        states: { a: {} },
      }),
    ).toThrow(/not declared/);
  });

  it("throws when transition target is not declared", () => {
    expect(() =>
      defineMachine({
        id: "m",
        initial: "a",
        context: {},
        states: {
          a: {
            on: {
              // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
              GO: { target: "ghost" as any },
            },
          },
        },
      }),
    ).toThrow(/unknown state/);
  });

  it("throws when states is empty", () => {
    expect(() =>
      defineMachine({
        id: "m",
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
        initial: "a" as any,
        context: {},
        states: {},
      }),
    ).toThrow(InvalidDefinitionError);
  });

  it("throws when an inline guard is declared async", () => {
    expect(() =>
      defineMachine({
        id: "m",
        initial: "a",
        context: {},
        states: {
          a: {
            on: {
              // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse to verify the guard check
              GO: { target: "b", guard: (async () => true) as any },
            },
          },
          b: {},
        },
      }),
    ).toThrow(/async guard/);
  });
});

describe("defineMachine / setup().defineMachine — explicit `context: undefined` (aifsmjs-19)", () => {
  it("defineMachine defaults an explicitly-undefined context to {}", () => {
    const def = defineMachine<{ n: number }, { type: string }, "a">({
      id: "explicit-undefined",
      initial: "a",
      // biome-ignore lint/suspicious/noExplicitAny: exercising the non-exact-optional caller shape
      context: undefined as any,
      states: { a: {} },
    });
    expect(def.context).toEqual({});
  });

  it("setup().defineMachine defaults an explicitly-undefined context to {}", () => {
    const def = setup<{ n: number }, { type: string }>().defineMachine({
      id: "explicit-undefined-setup",
      initial: "a",
      // biome-ignore lint/suspicious/noExplicitAny: exercising the non-exact-optional caller shape
      context: undefined as any,
      states: { a: {} },
    });
    expect(def.context).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// C2 — sub-machine definitions are deep-validated at construction.
//
// defineMachine ran validateDefinition at the TOP level only; a state's `sub`
// got a shallow shape check but its transitions + guards were never validated.
// A sub with an unknown transition target or a declared-async guard was
// accepted at construction and only blew up (or wedged into a ghost state) at
// child.send(). defineMachine must reject these eagerly, with a CYCLE GUARD so
// a self/mutually-referential sub does not cause infinite recursion.
// ---------------------------------------------------------------------------
describe("defineMachine — sub-machine deep validation (C2)", () => {
  it("throws InvalidDefinitionError when a sub has an unknown transition target", () => {
    expect(() =>
      defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
        id: "parent-sub-bad-target",
        initial: "a",
        context: { n: 0 },
        states: {
          a: {
            sub: {
              id: "child",
              initial: "x",
              context: {},
              states: {
                // "ghost-sub" is not a declared state of the sub → invalid.
                // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
                x: { on: { GO: { target: "ghost-sub" as any } } },
              },
              // biome-ignore lint/suspicious/noExplicitAny: cross-shape literal for the deep-validation test
            } as any,
            on: { GO: { target: "b" } },
          },
          b: {},
        },
      }),
    ).toThrow(InvalidDefinitionError);
  });

  it("throws InvalidDefinitionError when a sub has a declared-async guard", () => {
    expect(() =>
      defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
        id: "parent-sub-async-guard",
        initial: "a",
        context: { n: 0 },
        states: {
          a: {
            sub: {
              id: "child",
              initial: "x",
              context: {},
              states: {
                // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse to verify the guard check
                x: { on: { GO: { target: "y", guard: (async () => true) as any } } },
                y: {},
              },
              // biome-ignore lint/suspicious/noExplicitAny: cross-shape literal for the deep-validation test
            } as any,
            on: { GO: { target: "b" } },
          },
          b: {},
        },
      }),
    ).toThrow(/async guard/);
  });

  it("the async-guard rejection message names the offending transition (not silent until child.send())", () => {
    expect(() =>
      defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
        id: "parent-sub-async-guard-msg",
        initial: "a",
        context: { n: 0 },
        states: {
          a: {
            sub: {
              id: "child",
              initial: "x",
              context: {},
              states: {
                // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse to verify the guard check
                x: { on: { GO: { target: "y", guard: (async () => true) as any } } },
                y: {},
              },
              // biome-ignore lint/suspicious/noExplicitAny: cross-shape literal for the deep-validation test
            } as any,
            on: { GO: { target: "b" } },
          },
          b: {},
        },
      }),
    ).toThrow(InvalidDefinitionError);
  });

  it("accepts a sub whose transitions + guards are all valid", () => {
    expect(() =>
      defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
        id: "parent-sub-ok",
        initial: "a",
        context: { n: 0 },
        states: {
          a: {
            sub: {
              id: "child",
              initial: "x",
              context: {},
              states: {
                x: { on: { GO: { target: "y" } } },
                y: {},
              },
              // biome-ignore lint/suspicious/noExplicitAny: cross-shape literal for the deep-validation test
            } as any,
            on: { GO: { target: "b" } },
          },
          b: {},
        },
      }),
    ).not.toThrow();
  });

  it("cycle guard: a sub that references itself through a NON-initial state terminates and is accepted", () => {
    // Build a self-referential sub: parent.a.sub === the sub, and the sub's
    // non-initial state `y` points its `.sub` back at itself. Without a cycle
    // guard, recursive validation would never terminate. The cycle is legal:
    // the child for `y` is only built when `y` is entered, not at boot.
    // (0.5.x pinned the self-reference on the initial state `x`; that shape is
    // now rejected — see the aifsmjs-15 tests below.)
    // biome-ignore lint/suspicious/noExplicitAny: self-referential structure for the cycle-guard test
    const selfSub: any = {
      id: "self-sub",
      initial: "x",
      context: {},
      states: {
        x: { on: { GO: { target: "y" } } },
        y: {},
      },
    };
    // Close the cycle: the sub's non-initial state references the same sub.
    selfSub.states.y.sub = selfSub;

    expect(() =>
      defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
        id: "parent-cyclic-sub",
        initial: "a",
        context: { n: 0 },
        states: {
          a: { sub: selfSub, on: { GO: { target: "b" } } },
          b: {},
        },
      }),
    ).not.toThrow();
  });
});

describe("defineMachine — sub cycle through initial states (aifsmjs-15)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: cyclic sub graphs built by hand
  type Loose = any;
  const mk = (id: string): Loose => ({
    id,
    initial: "s",
    context: {},
    states: { s: { on: { GO: "t" } }, t: {} },
  });

  it("rejects a sub whose initial state re-enters the same sub", () => {
    const selfSub = mk("self");
    selfSub.states.s.sub = selfSub;
    const def: Loose = { id: "root", initial: "a", states: { a: { sub: selfSub } } };
    expect(() => defineMachine(def)).toThrow(InvalidDefinitionError);
    expect(() => defineMachine(def)).toThrow(
      /aifsmjs: sub-machine cycle through initial states: "self" is re-entered via initial-state subs/,
    );
  });

  it("rejects A.initial -> sub B, B.initial -> sub A at defineMachine", () => {
    const a = mk("A");
    const b = mk("B");
    a.states.s.sub = b;
    b.states.s.sub = a;
    const def: Loose = { id: "root", initial: "r", states: { r: { sub: a } } };
    expect(() => defineMachine(def)).toThrow(/sub-machine cycle through initial states/);
  });

  it("rejects a root whose initial state's sub chain leads back to the root", () => {
    const root = mk("root");
    const b = mk("B");
    root.states.s.sub = b;
    b.states.s.sub = root;
    expect(() => defineMachine(root)).toThrow(/sub-machine cycle through initial states/);
  });

  it("createMachine / setup().defineMachine reject it too, instead of overflowing the stack in createRuntime", () => {
    const a = mk("A");
    const b = mk("B");
    a.states.s.sub = b;
    b.states.s.sub = a;
    const def: Loose = { id: "root", initial: "r", states: { r: { sub: a } } };
    expect(() => createMachine(def, {})).toThrow(InvalidDefinitionError);
    expect(() => setup().defineMachine(def)).toThrow(InvalidDefinitionError);
  });

  it("accepts a self-sub on a non-initial state and still runs it", () => {
    const sub = mk("self");
    sub.states.t.sub = sub;
    const def = defineMachine<Record<string, never>, { type: "GO" }, "a">({
      id: "root",
      initial: "a",
      states: { a: { sub } },
    });
    const rt = createRuntime(def, {});
    const child = rt.subRuntime()!;
    child.send({ type: "GO" });
    expect(child.getSnapshot().value).toBe("t");
    expect(child.subRuntime()).toBeDefined();
  });
});

describe("defineMachine — argument shape (InvalidDefinitionError, not TypeError)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse from untyped callers
  const loose = (v: unknown): any => v;

  it("rejects a missing or non-object definition", () => {
    for (const bad of [undefined, null, 5, "m"]) {
      expect(() => defineMachine(loose(bad))).toThrow(InvalidDefinitionError);
      expect(() => setup().defineMachine(loose(bad))).toThrow(
        /^aifsmjs: definition must be an object$/,
      );
    }
    expect(() => createMachine(loose(undefined), {})).toThrow(InvalidDefinitionError);
  });

  it("rejects non-object states", () => {
    expect(() => defineMachine(loose({ id: "m", initial: "a", states: 5 }))).toThrow(
      /aifsmjs: definition states must be an object/,
    );
  });

  it("rejects a state that is not an object", () => {
    expect(() => defineMachine(loose({ id: "m", initial: "a", states: { a: null } }))).toThrow(
      /aifsmjs: state "a" must be an object/,
    );
    expect(() => defineMachine(loose({ id: "m", initial: "a", states: { a: {}, b: 5 } }))).toThrow(
      /aifsmjs: state "b" must be an object/,
    );
  });

  it("rejects a transition that is neither a state name nor an object", () => {
    expect(() =>
      defineMachine(loose({ id: "m", initial: "a", states: { a: { on: { GO: null } } } })),
    ).toThrow(/aifsmjs: transition a -\[GO\]-> must be an object/);
    expect(() =>
      defineMachine(loose({ id: "m", initial: "a", states: { a: { on: { GO: [5] } } } })),
    ).toThrow(InvalidDefinitionError);
  });
});

describe("initialSnapshot", () => {
  it("uses the initial state and context", () => {
    const def = defineMachine<{ n: number }, { type: string }, "a" | "b">({
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: { a: {}, b: {} },
    });
    const snap = initialSnapshot(def);
    expect(snap.value).toBe("a");
    expect(snap.context).toEqual({ n: 0 });
    expect(snap.status).toBe("active");
  });

  it("marks final state", () => {
    const def = defineMachine({
      id: "m",
      initial: "done",
      context: {},
      states: { done: { final: true } },
    });
    expect(initialSnapshot(def).status).toBe("final");
  });
});

describe("setup() — curried builder with inferred States", () => {
  it("infers States from keyof states (no explicit generics needed)", () => {
    type Ctx = { n: number };
    type Evt = { type: "INC" } | { type: "RESET" };
    const machine = setup<Ctx, Evt>().defineMachine({
      id: "counter",
      initial: "idle",
      context: { n: 0 },
      states: {
        idle: {
          on: {
            INC: { target: "ticking", actions: ["bump"] },
          },
        },
        ticking: {
          on: {
            INC: { target: "ticking", actions: ["bump"] },
            RESET: { target: "idle", actions: ["zero"] },
          },
        },
      },
    });
    expect(machine.initial).toBe("idle");
    expect(Object.keys(machine.states)).toEqual(["idle", "ticking"]);
  });

  it("works end-to-end through createRuntime", () => {
    type Ctx = { n: number };
    type Evt = { type: "INC" };
    // Terminal state `b: {}` targeted by a transition: States must still be
    // inferred from the keys, not collapsed to the target literal (aifsmjs-13).
    const machine = setup<Ctx, Evt>().defineMachine({
      id: "c",
      initial: "a",
      context: { n: 0 },
      states: {
        a: { on: { INC: { target: "b", actions: ["bump"] } } },
        b: {},
      },
    });
    const runtime = createRuntime(machine, {
      actions: { bump: assign(({ context }) => ({ n: context.n + 1 })) },
    });
    runtime.send({ type: "INC" });
    expect(runtime.getSnapshot().value).toBe("b");
    expect(runtime.getSnapshot().context.n).toBe(1);
  });

  it("infers States from keys when a transition targets a terminal state (aifsmjs-13)", () => {
    type Ctx = { n: number };
    type Evt = { type: "GO" };
    const withFinal = setup<Ctx, Evt>().defineMachine({
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { GO: { target: "b" } } }, b: { final: true } },
    });
    const withEmpty = setup<Ctx, Evt>().defineMachine({
      id: "m2",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { GO: "b" } }, b: {} },
    });
    expectTypeOf(withFinal).toEqualTypeOf<MachineDef<Ctx, Evt, "a" | "b">>();
    expectTypeOf(withEmpty).toEqualTypeOf<MachineDef<Ctx, Evt, "a" | "b">>();
    expect(Object.keys(withFinal.states)).toEqual(["a", "b"]);
    expect(Object.keys(withEmpty.states)).toEqual(["a", "b"]);
  });

  it("still rejects a transition target outside the inferred States", () => {
    type Ctx = { n: number };
    type Evt = { type: "GO" };
    expect(() =>
      setup<Ctx, Evt>().defineMachine({
        id: "m",
        initial: "a",
        context: { n: 0 },
        // @ts-expect-error "ghost" is not a declared state
        states: { a: { on: { GO: { target: "ghost" } } }, b: {} },
      }),
    ).toThrow(/unknown state/);
  });

  it("still validates: rejects initial outside states", () => {
    type Ctx = Record<string, never>;
    type Evt = { type: "X" };
    expect(() =>
      setup<Ctx, Evt>().defineMachine({
        id: "m",
        // @ts-expect-error initial not in states keys
        initial: "ghost",
        context: {},
        states: { a: {} },
      }),
    ).toThrow(/not declared/);
  });
});

describe("createMachine() — single-factory convenience", () => {
  it("returns a runtime that behaves like defineMachine + createRuntime", () => {
    type C = { n: number };
    type E = { type: "INC" };
    const runtime = createMachine<C, E, "a" | "b">(
      {
        id: "m",
        initial: "a",
        context: { n: 0 },
        states: {
          a: { on: { INC: { target: "b", actions: ["bump"] } } },
          b: {},
        },
      },
      { actions: { bump: assign(({ context }) => ({ n: context.n + 1 })) } },
    );
    expect(runtime.snapshot().value).toBe("a");
    runtime.send({ type: "INC" });
    expect(runtime.snapshot().value).toBe("b");
    expect(runtime.snapshot().context.n).toBe(1);
  });

  it("validates the definition (rejects unknown initial state)", () => {
    type C = Record<string, never>;
    type E = { type: "X" };
    expect(() =>
      createMachine<C, E, "a">(
        {
          id: "bad",
          // @ts-expect-error initial not in states
          initial: "ghost",
          context: {},
          states: { a: {} },
        },
        {},
      ),
    ).toThrow(/not declared/);
  });
});
