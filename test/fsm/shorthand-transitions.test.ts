import { describe, expect, it } from "vitest";
import { createMachine, defineMachine, setup } from "../../src/fsm/definition.js";
import { step } from "../../src/fsm/lifecycle.js";
import {
  normalizeTransition,
  normalizeTransitions,
  resolveTransitions,
} from "../../src/fsm/resolver.js";
import { createRuntime } from "../../src/fsm/runtime.js";
import type { Implementations } from "../../src/fsm/types.js";

// F1 — string-shorthand transitions: `on: { EVENT: "targetState" }` is
// normalized to `{ target: "targetState" }` à la XState.
describe("string-shorthand transitions (F1)", () => {
  type Ctx = { hits: number };
  type Evt = { type: "GO" } | { type: "BACK" } | { type: "BUMP" };
  type S = "a" | "b" | "c";

  // Explicit generics (the form used across the existing fixtures) so `States`
  // does not collapse — independent of the shorthand under test.
  const machine = defineMachine<Ctx, Evt, S>({
    id: "shorthand",
    initial: "a",
    context: { hits: 0 },
    states: {
      // bare string shorthand
      a: { on: { GO: "b" } },
      b: {
        on: {
          BACK: "a",
          // shorthand mixed with object form inside an array (guard fallthrough)
          GO: [{ target: "c", guard: "never" }, "a"],
          // self-transition with actions stays in object form
          BUMP: { actions: ["bump"] },
        },
      },
      c: {},
    },
  });

  const impl: Implementations<Ctx, Evt> = {
    guards: { never: () => false },
    actions: { bump: ({ context }) => ({ hits: context.hits + 1 }) },
  };

  it("normalizeTransition converts a bare string to { target }", () => {
    expect(normalizeTransition<Ctx, Evt, S>("b")).toEqual({ target: "b" });
    // object form passes through unchanged (same reference)
    const obj = { target: "b", actions: ["x"] } as const;
    expect(normalizeTransition<Ctx, Evt, S>(obj)).toBe(obj);
  });

  it("normalizeTransitions handles undefined | string | object | mixed array", () => {
    expect(normalizeTransitions(undefined)).toEqual([]);
    expect(normalizeTransitions<Ctx, Evt, S>("a")).toEqual([{ target: "a" }]);
    expect(normalizeTransitions<Ctx, Evt, S>(["a", { target: "c" }])).toEqual([
      { target: "a" },
      { target: "c" },
    ]);
  });

  it("resolveTransitions normalizes the string shorthand", () => {
    expect(resolveTransitions(machine, "a", "GO")).toEqual([{ target: "b" }]);
  });

  it("step() fires a shorthand transition", () => {
    const r = step(
      machine,
      { value: "a", context: { hits: 0 }, status: "active" },
      { type: "GO" },
      impl,
    );
    expect(r.changed).toBe(true);
    expect(r.snapshot.value).toBe("b");
  });

  it("runtime.send drives shorthand transitions both directions", () => {
    const rt = createRuntime(machine, impl);
    expect(rt.send({ type: "GO" }).value).toBe("b"); // a -> b via "b"
    expect(rt.send({ type: "BACK" }).value).toBe("a"); // b -> a via "a"
  });

  it("shorthand participates in guard fallthrough arrays", () => {
    const rt = createRuntime(machine, impl);
    rt.send({ type: "GO" }); // a -> b
    // GO in b: first candidate guarded by `never` (fails) -> falls to "a"
    expect(rt.send({ type: "GO" }).value).toBe("a");
  });

  it("runtime.can reflects shorthand transitions", () => {
    const rt = createRuntime(machine, impl);
    expect(rt.can({ type: "GO" })).toBe(true);
    expect(rt.can({ type: "BACK" })).toBe(false); // no BACK declared in state a
  });

  it("validation rejects a shorthand pointing at an unknown state", () => {
    expect(() =>
      defineMachine<Ctx, Evt, S>({
        id: "bad",
        initial: "a",
        context: { hits: 0 },
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid target for the negative test
        states: { a: { on: { GO: "ghost" as any } }, b: {}, c: {} },
      }),
    ).toThrow(/unknown state/);
  });

  it("createMachine supports shorthand end-to-end", () => {
    const rt = createMachine(machine, impl);
    expect(rt.send({ type: "GO" }).value).toBe("b");
  });
});

// F2 — optional context: `context` may be omitted, defaulting to `{}`.
describe("optional context (F2)", () => {
  it("defineMachine defaults context to {} when omitted", () => {
    const m = defineMachine({
      id: "no-ctx",
      initial: "idle",
      states: {
        idle: { on: { PING: "idle" } },
      },
    });
    expect(m.context).toEqual({});
    const rt = createRuntime(m, {});
    expect(rt.getSnapshot().context).toEqual({});
    expect(rt.send({ type: "PING" }).value).toBe("idle");
  });

  it("setup().defineMachine defaults context to {} when omitted", () => {
    const m = setup().defineMachine({
      id: "no-ctx-setup",
      initial: "idle",
      states: {
        idle: { on: { PING: "idle" } },
      },
    });
    expect(m.context).toEqual({});
    const rt = createRuntime(m, {});
    expect(rt.send({ type: "PING" }).value).toBe("idle");
  });

  it("explicit context still works unchanged", () => {
    const m = defineMachine<{ n: number }, { type: "INC" }, "s">({
      id: "with-ctx",
      initial: "s",
      context: { n: 5 },
      states: { s: {} },
    });
    expect(m.context).toEqual({ n: 5 });
  });
});
