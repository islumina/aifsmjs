import { describe, expect, it } from "vitest";
import {
  AsyncGuardError,
  evalGuard,
  isAsyncGuardFn,
  resolveGuard,
  UnknownGuardError,
} from "../../src/fsm/evaluator.js";
import type { Guard, Implementations } from "../../src/fsm/types.js";

type Ctx = { n: number };
type Evt = { type: "X" };

describe("evaluator", () => {
  const isPositive: Guard<Ctx, Evt> = ({ context }) => context.n > 0;
  const impl: Implementations<Ctx, Evt> = {
    guards: { isPositive },
  };

  it("resolves a string ref", () => {
    expect(resolveGuard("isPositive", impl)).toBe(isPositive);
  });

  it("returns inline function as-is", () => {
    const inline: Guard<Ctx, Evt> = () => true;
    expect(resolveGuard(inline, impl)).toBe(inline);
  });

  it("throws UnknownGuardError for unknown name", () => {
    expect(() => resolveGuard("ghost", impl)).toThrow(UnknownGuardError);
  });

  it("evaluates with threaded guards map and value", () => {
    expect(evalGuard("isPositive", { n: 1 }, { type: "X" }, impl, "anyState")).toBe(true);
    expect(evalGuard("isPositive", { n: -1 }, { type: "X" }, impl)).toBe(false);
  });

  it("evaluates inline function ignoring impl.guards", () => {
    const g: Guard<Ctx, Evt> = ({ context }) => context.n === 42;
    expect(evalGuard(g, { n: 42 }, { type: "X" }, impl)).toBe(true);
  });

  it("isAsyncGuardFn flags declared-async guard functions", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate any to bypass TS guard check
    const asyncGuard: any = async () => true;
    expect(isAsyncGuardFn(asyncGuard)).toBe(true);
    expect(isAsyncGuardFn(() => true)).toBe(false);
    expect(isAsyncGuardFn("not a function")).toBe(false);
    expect(isAsyncGuardFn(undefined)).toBe(false);
  });

  it("evalGuard throws AsyncGuardError on declared-async inline guard", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate any to bypass TS guard check
    const asyncGuard: any = async () => true;
    expect(() => evalGuard(asyncGuard, { n: 0 }, { type: "X" }, impl)).toThrow(AsyncGuardError);
  });

  it("evalGuard throws AsyncGuardError on Promise-returning guard slipped through cast", () => {
    // Simulates a user that wrote `() => fetchSomething()` and cast it to Guard.
    const promiseReturning = (() => Promise.resolve(true)) as unknown as Guard<Ctx, Evt>;
    expect(() => evalGuard(promiseReturning, { n: 0 }, { type: "X" }, impl)).toThrow(
      AsyncGuardError,
    );
  });

  it("evalGuard throws AsyncGuardError when a string-ref points at an async impl", () => {
    const asyncImpl: Implementations<Ctx, Evt> = {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate any to bypass TS guard check
      guards: { badGuard: (async () => true) as any },
    };
    expect(() => evalGuard("badGuard", { n: 0 }, { type: "X" }, asyncImpl)).toThrow(
      AsyncGuardError,
    );
  });

  it("evalGuard throws AsyncGuardError for cross-realm Promise-like thenables", () => {
    // Simulates a Promise returned from another realm (iframe / worker / vm)
    // or a user-defined thenable — `instanceof Promise` would have missed it.
    // biome-ignore lint/suspicious/noThenProperty: deliberate thenable for the regression
    const thenable = { then: (_: () => void) => {} };
    const fakeGuard = (() => thenable) as unknown as Guard<Ctx, Evt>;
    expect(() => evalGuard(fakeGuard, { n: 0 }, { type: "X" }, impl)).toThrow(AsyncGuardError);
  });

  it("evalGuard reports <inline> for anonymous-arrow guards (empty Function.name)", () => {
    // biome-ignore lint/suspicious/noThenProperty: deliberate thenable for the regression
    const thenable = { then: (_: () => void) => {} };
    const anon = (() => thenable) as unknown as Guard<Ctx, Evt>;
    Object.defineProperty(anon, "name", { value: "" });
    try {
      evalGuard(anon, { n: 0 }, { type: "X" }, impl);
      throw new Error("expected to throw");
    } catch (err) {
      // The error message uses "<inline>" not the empty string.
      expect((err as Error).message).toMatch(/<inline>/);
    }
  });
});
