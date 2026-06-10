import { describe, expect, it } from "vitest";
import { AsyncGuardError, evalGuard } from "../../src/fsm/evaluator.js";
import type { Guard, Implementations } from "../../src/fsm/types.js";
import { and, not, or, stateIn } from "../../src/guards/index.js";

type Ctx = { n: number };
type Evt = { type: "X" };

const positive: Guard<Ctx, Evt> = ({ context }) => context.n > 0;
const big: Guard<Ctx, Evt> = ({ context }) => context.n > 10;
const small: Guard<Ctx, Evt> = ({ context }) => context.n < 5;

// A guard that (illegally) returns a thenable. TS's Guard return type is
// `boolean`, so a conforming caller cannot construct this directly; a JS
// caller or a cast can. evalGuard rejects it via isThenable at the top level
// — these tests prove the SAME rejection fires when the offending guard is
// buried inside a combinator (and/or/not), where the combinator would
// otherwise coerce the thenable to a truthy boolean and silently bypass the
// async-guard safety net.
const thenableGuard = (() => Promise.resolve(true)) as unknown as Guard<Ctx, Evt>;

describe("and/or/not — inline guards", () => {
  it("and short-circuits", () => {
    let calls = 0;
    const tracking: Guard<Ctx, Evt> = () => {
      calls++;
      return true;
    };
    const g = and<Ctx, Evt>([({ context }) => context.n > 100, tracking]);
    expect(g({ context: { n: 1 }, event: { type: "X" } })).toBe(false);
    expect(calls).toBe(0);
  });

  it("or short-circuits", () => {
    let calls = 0;
    const tracking: Guard<Ctx, Evt> = () => {
      calls++;
      return false;
    };
    const g = or<Ctx, Evt>([positive, tracking]);
    expect(g({ context: { n: 1 }, event: { type: "X" } })).toBe(true);
    expect(calls).toBe(0);
  });

  it("not negates", () => {
    expect(not<Ctx, Evt>(positive)({ context: { n: 0 }, event: { type: "X" } })).toBe(true);
  });

  it("and([positive, small]) — both true", () => {
    const g = and<Ctx, Evt>([positive, small]);
    expect(g({ context: { n: 2 }, event: { type: "X" } })).toBe(true);
    expect(g({ context: { n: 20 }, event: { type: "X" } })).toBe(false);
  });

  it("or([big, small]) — neither true at n=7", () => {
    const g = or<Ctx, Evt>([big, small]);
    expect(g({ context: { n: 7 }, event: { type: "X" } })).toBe(false);
    expect(g({ context: { n: 2 }, event: { type: "X" } })).toBe(true);
    expect(g({ context: { n: 20 }, event: { type: "X" } })).toBe(true);
  });
});

describe("and/or/not — string refs through evalGuard", () => {
  const impl: Implementations<Ctx, Evt> = {
    guards: { positive, big, small },
  };

  it("resolves nested string refs", () => {
    const composed = and<Ctx, Evt>(["positive", or<Ctx, Evt>(["big", "small"])]);
    expect(evalGuard(composed, { n: 2 }, { type: "X" }, impl)).toBe(true);
    expect(evalGuard(composed, { n: 7 }, { type: "X" }, impl)).toBe(false);
  });

  it("not('positive')", () => {
    const g = not<Ctx, Evt>("positive");
    expect(evalGuard(g, { n: 0 }, { type: "X" }, impl)).toBe(true);
    expect(evalGuard(g, { n: 1 }, { type: "X" }, impl)).toBe(false);
  });

  it("throws for unknown string ref", () => {
    const g = and<Ctx, Evt>(["ghost"]);
    expect(() => evalGuard(g, { n: 1 }, { type: "X" }, impl)).toThrow(/ghost/);
  });
});

describe("and/or/not — async-guard safety net (FSM-S-01)", () => {
  const impl: Implementations<Ctx, Evt> = {
    guards: { positive, thenable: thenableGuard },
  };

  it("and() throws AsyncGuardError when an inner guard returns a thenable", () => {
    // Inner thenable must be reached: short-circuit on a true guard first, so
    // place the thenable AFTER a passing guard (and continues while true).
    const g = and<Ctx, Evt>([positive, thenableGuard]);
    expect(() => g({ context: { n: 1 }, event: { type: "X" } })).toThrow(AsyncGuardError);
  });

  it("or() throws AsyncGuardError when an inner guard returns a thenable", () => {
    // or short-circuits on the first true; place a failing guard first so the
    // thenable is evaluated rather than skipped.
    const g = or<Ctx, Evt>([({ context }) => context.n > 100, thenableGuard]);
    expect(() => g({ context: { n: 1 }, event: { type: "X" } })).toThrow(AsyncGuardError);
  });

  it("not() throws AsyncGuardError when its guard returns a thenable", () => {
    const g = not<Ctx, Evt>(thenableGuard);
    expect(() => g({ context: { n: 1 }, event: { type: "X" } })).toThrow(AsyncGuardError);
  });

  it("nested combinators: thenable buried two levels deep still throws", () => {
    const g = and<Ctx, Evt>([positive, or<Ctx, Evt>([({ context }) => context.n > 100, thenableGuard])]);
    expect(() => g({ context: { n: 1 }, event: { type: "X" } })).toThrow(AsyncGuardError);
  });

  it("string-ref thenable guard through evalGuard also throws (not coerced truthy)", () => {
    const composed = and<Ctx, Evt>(["positive", "thenable"]);
    expect(() => evalGuard(composed, { n: 1 }, { type: "X" }, impl)).toThrow(AsyncGuardError);
  });

  it("boolean-returning combinators are unaffected (no false positives)", () => {
    expect(and<Ctx, Evt>([positive, small])({ context: { n: 2 }, event: { type: "X" } })).toBe(true);
    expect(not<Ctx, Evt>(positive)({ context: { n: 0 }, event: { type: "X" } })).toBe(true);
  });
});

describe("stateIn", () => {
  it("returns true when current value is in the list", () => {
    const g = stateIn<Ctx, Evt>("a", "b", "c");
    expect(g({ context: { n: 0 }, event: { type: "X" }, value: "b" })).toBe(true);
    expect(g({ context: { n: 0 }, event: { type: "X" }, value: "d" })).toBe(false);
  });

  it("returns false when value is undefined", () => {
    const g = stateIn<Ctx, Evt>("a");
    expect(g({ context: { n: 0 }, event: { type: "X" } })).toBe(false);
  });
});
