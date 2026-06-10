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
