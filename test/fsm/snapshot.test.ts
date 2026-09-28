import { describe, expect, it } from "vitest";
import { defineMachine } from "../../src/fsm/definition.js";
import { createRuntime } from "../../src/fsm/runtime.js";
import { createSnapshot, deepFreeze } from "../../src/fsm/snapshot.js";
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
