import { describe, expect, it, vi } from "vitest";
import { defineMachine } from "../../src/fsm/definition.js";
import { createRuntime } from "../../src/fsm/runtime.js";
import { createSnapshot, deepFreeze } from "../../src/fsm/snapshot.js";
import type { Implementations } from "../../src/fsm/types.js";
import { logger } from "../../src/inspect/index.js";

describe("snapshot helpers", () => {
  it("createSnapshot freezes the top object", () => {
    const s = createSnapshot({ value: "a", context: { n: 1 } });
    expect(Object.isFrozen(s)).toBe(true);
  });

  it("deepFreeze freezes nested objects", () => {
    const root = { a: { b: { c: 1 } }, arr: [{ x: 1 }] };
    deepFreeze(root);
    expect(Object.isFrozen(root.a)).toBe(true);
    expect(Object.isFrozen(root.a.b)).toBe(true);
    expect(Object.isFrozen(root.arr)).toBe(true);
    expect(Object.isFrozen(root.arr[0])).toBe(true);
  });

  it("snapshot round-trips through JSON", () => {
    const s = createSnapshot({ value: "red", context: { ticks: 0 } });
    const json = JSON.stringify(s);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ value: "red", context: { ticks: 0 }, status: "active" });
  });

  it("deepFreeze short-circuits on primitives and frozen values", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze(42)).toBe(42);
    const already = Object.freeze({ a: 1 });
    expect(deepFreeze(already)).toBe(already);
  });

  it("createSnapshot honours explicit status='final'", () => {
    const s = createSnapshot({ value: "done", context: {}, status: "final" });
    expect(s.status).toBe("final");
  });
});

describe("deepFreeze — binary data (aifsmjs-2)", () => {
  it("leaves a non-empty TypedArray in context unfrozen instead of throwing", () => {
    const buf = new Uint8Array(4);
    expect(() => createSnapshot({ value: "a", context: { buf } })).not.toThrow();
    const root = deepFreeze({ buf, nested: { n: 1 } });
    expect(root.buf).toBe(buf);
    expect(Object.isFrozen(root.nested)).toBe(true);
  });

  it("createRuntime accepts a Uint8Array in the initial context", () => {
    const def = defineMachine<{ buf: Uint8Array }, { type: "X" }, "a">({
      id: "bin-ctx",
      initial: "a",
      context: { buf: new Uint8Array(4) },
      states: { a: {} },
    });
    expect(() => createRuntime(def, {})).not.toThrow();
  });

  it("send() with a Uint8Array payload and a middleware commits and notifies", () => {
    const def = defineMachine<{ n: number }, { type: "DATA"; bytes: Uint8Array }, "a" | "b">({
      id: "bin-evt",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { DATA: "b" } }, b: {} },
    });
    const rt = createRuntime(def, {}, { middleware: [logger(() => {})] });
    const seen: string[] = [];
    rt.subscribe((s) => seen.push(s.value));
    expect(() => rt.send({ type: "DATA", bytes: new Uint8Array(3) })).not.toThrow();
    expect(rt.getSnapshot().value).toBe("b");
    expect(seen).toEqual(["b"]);
  });
});

describe("deepFreeze — shallow-frozen inputs (aifsmjs-5)", () => {
  it("recurses into an object that is already frozen at the top level", () => {
    const root = Object.freeze({ items: [1, 2], nested: { n: 1 } });
    deepFreeze(root);
    expect(Object.isFrozen(root.items)).toBe(true);
    expect(Object.isFrozen(root.nested)).toBe(true);
  });

  it.skipIf(process.env.NODE_ENV === "production")(
    "dev: createSnapshot deep-freezes a shallow-frozen context",
    () => {
      const s = createSnapshot({ value: "a", context: Object.freeze({ items: [1, 2] }) });
      expect(Object.isFrozen(s.context.items)).toBe(true);
    },
  );

  it("terminates on cyclic plain objects", () => {
    const a: { self?: unknown; b: { back?: unknown } } = { b: {} };
    a.self = a;
    a.b.back = a;
    expect(deepFreeze(a)).toBe(a);
    expect(Object.isFrozen(a.b)).toBe(true);
  });

  it("middleware cannot mutate an effect payload; the handler sees the original", () => {
    type PCtx = { n: number };
    type PEvt = { type: "PAY" };
    const def = defineMachine<PCtx, PEvt, "a" | "b">({
      id: "pay",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { PAY: { target: "b", actions: ["charge"] } } }, b: {} },
    });
    const received: number[] = [];
    const impl: Implementations<PCtx, PEvt> = {
      actions: {
        charge: ({ enqueue }) => {
          enqueue.effect("charge", { amount: 10 });
        },
      },
      effects: {
        charge: (eff) => {
          received.push((eff.payload as { amount: number }).amount);
        },
      },
    };
    const rt = createRuntime(def, impl, {
      middleware: [
        (mw, next) => {
          expect(() => {
            (mw.effects[0]?.payload as { amount: number }).amount = 9999;
          }).toThrow(TypeError);
          next();
        },
      ],
    });
    rt.send({ type: "PAY" });
    expect(received).toEqual([10]);
  });

  it("production-depth snapshots keep nested context unfrozen through middleware", () => {
    const ctx = { nested: { n: 1 } };
    const def = defineMachine<typeof ctx, { type: "GO" }, "a" | "b">({
      id: "prod-depth",
      initial: "a",
      context: ctx,
      states: { a: { on: { GO: "b" } }, b: {} },
    });
    const rt = createRuntime(def, {}, { middleware: [logger(() => {})] });
    rt.send({ type: "GO" });
    expect(Object.isFrozen(rt.getSnapshot())).toBe(true);
    expect(Object.isFrozen(ctx.nested)).toBe(process.env.NODE_ENV !== "production");
  });

  it("IS_DEV computation does not throw when the `process` global is absent (aifsmjs-20)", async () => {
    // A bundler define-replacement (Vite, webpack 5) only substitutes the
    // `process.env.NODE_ENV` expression textually; it does not polyfill a
    // runtime `process` global. Simulate that by removing `process` entirely
    // and re-importing a fresh copy of the module: the try/catch around the
    // read must swallow the ReferenceError and fall back to a shallow freeze,
    // never throw.
    const originalProcess = globalThis.process;
    // biome-ignore lint/performance/noDelete: test-only global removal to simulate a browser build
    delete (globalThis as { process?: unknown }).process;
    vi.resetModules();
    try {
      const fresh = await import("../../src/fsm/snapshot.js");
      const ctx = { nested: { n: 1 } };
      expect(() => fresh.createSnapshot({ value: "a", context: ctx })).not.toThrow();
      const s = fresh.createSnapshot({ value: "a", context: ctx });
      expect(Object.isFrozen(s)).toBe(true);
      // No `process` global to read NODE_ENV from -> falls back to false (shallow freeze only).
      expect(Object.isFrozen(ctx.nested)).toBe(false);
    } finally {
      globalThis.process = originalProcess;
      vi.resetModules();
    }
  });
});
