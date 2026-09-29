import { describe, expect, it } from "vitest";
import type { MachineConfig } from "../../src/fsm/index.js";
import { InvalidActionResultError, defineMachine } from "../../src/fsm/index.js";
import * as root from "../../src/index.js";
import { properties } from "../../src/pbt/index.js";

describe("src/fsm/index.ts public surface (aifsmjs-21)", () => {
  it("re-exports MachineConfig, the parameter type of defineMachine", () => {
    // Compile-time assertion: this would fail to typecheck (TS2305-equivalent
    // "has no exported member 'MachineConfig'") if the root barrel dropped it.
    const config: MachineConfig<{ n: number }, { type: "GO" }, "a" | "b"> = {
      id: "m",
      initial: "a",
      context: { n: 0 },
      states: { a: { on: { GO: "b" } }, b: {} },
    };
    const def = defineMachine(config);
    expect(def.id).toBe("m");
  });
});

describe("0.6.0 surface", () => {
  it("exports InvalidActionResultError from the root; internal helpers stay private", () => {
    expect(root.InvalidActionResultError).toBe(InvalidActionResultError);
    expect(new InvalidActionResultError("a", 0)).toBeInstanceOf(Error);
    for (const internal of ["stepWithMeta", "chooseTransition", "assertObject", "IS_DEV"]) {
      expect(internal in root).toBe(false);
    }
  });

  it("aifsmjs/pbt `properties` is a frozen object carrying every property helper", () => {
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.keys(properties).sort()).toEqual([
      "assertAll",
      "assignDoesNotMutate",
      "contextEquals",
      "guardsFalseNoTransition",
      "reachableStatesSubsetDeclared",
      "replayEqualsFold",
      "snapshotAlwaysFrozen",
      "unknownEventNoOp",
    ]);
  });
});
