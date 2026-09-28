import { describe, expect, it } from "vitest";
import type { MachineConfig } from "../../src/fsm/index.js";
import { defineMachine } from "../../src/fsm/index.js";

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
