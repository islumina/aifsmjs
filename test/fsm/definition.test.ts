import { describe, expect, it } from "vitest";
import {
  InvalidDefinitionError,
  createMachine,
  defineMachine,
  initialSnapshot,
  setup,
} from "../../src/fsm/definition.js";
import { createRuntime } from "../../src/fsm/runtime.js";
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

  it("cycle guard: a sub that references itself terminates (no stack overflow)", () => {
    // Build a self-referential sub: parent.a.sub === the sub, and the sub's
    // own state also points its `.sub` back at itself. Without a cycle guard,
    // recursive validation would never terminate. The valid (cyclic but
    // otherwise correct) definition must construct without throwing or hanging.
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
    // Close the cycle: the sub's state references the same sub object.
    selfSub.states.x.sub = selfSub;

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
    // Explicit States generic: terminal state `b: {}` under-constrains the
    // curried setup() inference and collapses the union; the inference path
    // itself is covered by the sibling test above. Behaviour is identical.
    const machine = defineMachine<Ctx, Evt, "a" | "b">({
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
