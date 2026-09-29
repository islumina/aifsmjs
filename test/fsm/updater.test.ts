import { describe, expect, it } from "vitest";
import { createEnqueuer } from "../../src/effects/enqueuer.js";
import { defineMachine } from "../../src/fsm/definition.js";
import { InvalidActionResultError } from "../../src/fsm/lifecycle.js";
import { createRuntime } from "../../src/fsm/runtime.js";
import { assign, mergeContext } from "../../src/fsm/updater.js";

type Ctx = { n: number; name: string };

describe("assign", () => {
  it("returns a partial-producing Action", () => {
    const action = assign<Ctx, { type: "X" }>(({ context }) => ({
      n: context.n + 1,
    }));
    const result = action({
      context: { n: 0, name: "" },
      event: { type: "X" },
      enqueue: { effect: () => {} },
    });
    expect(result).toEqual({ n: 1 });
  });
});

describe("mergeContext", () => {
  it("does not mutate the original", () => {
    const original = { n: 0, name: "init" };
    const merged = mergeContext(original, { n: 1 });
    expect(merged).toEqual({ n: 1, name: "init" });
    expect(original.n).toBe(0);
    expect(merged).not.toBe(original);
  });

  it("returns the original when patch is void", () => {
    const c = { n: 0 };
    expect(mergeContext(c, undefined)).toBe(c);
  });

  it("replaces non-object contexts", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing edge case
    const merged = mergeContext(1 as any, 2 as any);
    expect(merged).toBe(2);
  });

  it("merges contexts that use Object.create(null)", () => {
    const a = Object.create(null) as Record<string, number>;
    a.x = 1;
    const merged = mergeContext(a, { y: 2 });
    expect(merged).toEqual({ x: 1, y: 2 });
    expect(merged).not.toBe(a);
  });
});

describe("mergeContext — non-plain and falsy cases (aifsmjs-11)", () => {
  class Counter {
    n = 0;
    label = "c";
    double(): number {
      return this.n * 2;
    }
  }

  it("a class-instance context keeps its prototype and untouched fields after an assign patch", () => {
    const def = defineMachine<Counter, { type: "INC" }, "a">({
      id: "class-ctx",
      initial: "a",
      context: new Counter(),
      states: { a: { on: { INC: { actions: ["inc"] } } } },
    });
    const rt = createRuntime(def, {
      actions: { inc: assign(({ context }) => ({ n: context.n + 1 })) },
    });
    const next = rt.send({ type: "INC" }).context;
    expect(next).toBeInstanceOf(Counter);
    expect(next.n).toBe(1);
    expect(next.label).toBe("c");
    expect(next.double()).toBe(2);
    expect(def.context.n).toBe(0);
  });

  it("a non-nullish primitive patch on an object context throws InvalidActionResultError", () => {
    // biome-ignore lint/suspicious/noExplicitAny: primitive patch from an untyped action
    const bad = (v: unknown): any => v;
    for (const patch of [false, 0, "", 1n, Symbol("s")]) {
      expect(() => mergeContext({ n: 0 }, bad(patch))).toThrow(InvalidActionResultError);
    }
    expect(() => mergeContext({ n: 0 }, bad(false), "flag")).toThrow(/action "flag"/);
    expect(() => mergeContext({ n: 0 }, bad(false))).toThrow(/action "<inline>"/);
  });

  it("a primitive context is replaced by any patch", () => {
    // biome-ignore lint/suspicious/noExplicitAny: primitive context
    expect(mergeContext(0 as any, false as any)).toBe(false);
  });

  it("an array context is replaced by an array patch", () => {
    const next = [3];
    expect(mergeContext([1, 2], next)).toBe(next);
  });

  it("a non-plain-object patch (array or class instance) replaces an object context", () => {
    const arr = [1];
    const inst = new Counter();
    // biome-ignore lint/suspicious/noExplicitAny: replacement semantics
    expect(mergeContext({ n: 0 } as any, arr as any)).toBe(arr);
    // biome-ignore lint/suspicious/noExplicitAny: replacement semantics
    expect(mergeContext({ n: 0 } as any, inst as any)).toBe(inst);
  });

  it("a JSON-derived __proto__ key stays a plain data property and never re-prototypes the context", () => {
    const patch = JSON.parse('{"__proto__": {"admin": true}, "n": 1}');
    const merged = mergeContext<Record<string, unknown>>({ n: 0 }, patch);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as { admin?: unknown }).admin).toBeUndefined();
    expect(merged.n).toBe(1);
  });

  it("a null-prototype context keeps its null prototype", () => {
    const a = Object.create(null) as Record<string, number>;
    a.x = 1;
    const merged = mergeContext(a, { y: 2 });
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect({ ...merged }).toEqual({ x: 1, y: 2 });
  });

  it("symbol keys are carried over", () => {
    const k = Symbol("k");
    const merged = mergeContext<Record<PropertyKey, number>>({ [k]: 1 }, { n: 2 });
    expect(merged[k]).toBe(1);
  });
});

describe("createEnqueuer", () => {
  it("pushes effects with payload", () => {
    const sink: { type: string; payload?: unknown }[] = [];
    const enq = createEnqueuer(sink);
    enq.effect("a", { x: 1 });
    enq.effect("b");
    expect(sink).toHaveLength(2);
    expect(sink[0]).toEqual({ type: "a", payload: { x: 1 } });
    expect(sink[1]).toEqual({ type: "b" });
  });
});
