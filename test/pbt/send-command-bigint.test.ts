import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine } from "../../src/index.js";
import { commandsFromMachine } from "../../src/pbt/index.js";

type Evt = { type: "ADD"; amount: bigint };
const def = defineMachine<{ n: number }, Evt, "a">({
  id: "big",
  initial: "a",
  context: { n: 0 },
  states: { a: { on: { ADD: {} } } },
});

describe("SendCommand.toString with BigInt event payloads", () => {
  it("a failing property still reports the send(...) counterexample", () => {
    const arbs = { ADD: fc.bigInt().map((amount): Evt => ({ type: "ADD", amount })) };
    let message = "";
    try {
      fc.assert(
        fc.property(commandsFromMachine(def, {}, arbs), (cmds) => {
          let ran = 0;
          for (const c of cmds) {
            c.run({ value: "a", context: { n: 0 }, status: "active", reached: new Set() }, {
              getSnapshot: () => ({ value: "a", context: { n: 0 }, status: "active" }),
              send: () => undefined,
            } as never);
            ran++;
          }
          return ran === 0;
        }),
        { numRuns: 50, seed: 1 },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Property failed/);
    expect(message).toContain("send(");
    expect(message).not.toContain("[object Object]");
  });
});
