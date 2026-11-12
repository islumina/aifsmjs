import * as fc from "fast-check";
import { step } from "../fsm/lifecycle.js";
import type { Implementations, MachineDef, Runtime, Snapshot } from "../fsm/types.js";

/**
 * Pure-model representation of an FSM run, used by `fc.commands`.
 * `reached` tracks every state visited so generic properties can check
 * containment without re-running.
 */
export type FsmModel<Ctx, States extends string> = {
  value: States;
  context: Ctx;
  status: "active" | "final";
  reached: Set<States>;
};

export type EventArbitraries<Evt extends { type: string }> = Readonly<
  Record<string, fc.Arbitrary<Evt>>
>;

export type FsmCommand<Ctx, Evt extends { type: string }, States extends string> = fc.Command<
  FsmModel<Ctx, States>,
  Runtime<Ctx, Evt, States>
>;

export function initialModel<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
): FsmModel<Ctx, States> {
  return {
    value: def.initial,
    context: def.context,
    status: def.states[def.initial]?.final ? "final" : "active",
    reached: new Set([def.initial]),
  };
}

class SendCommand<Ctx, Evt extends { type: string }, States extends string>
  implements FsmCommand<Ctx, Evt, States>
{
  constructor(
    private readonly event: Evt,
    private readonly def: MachineDef<Ctx, Evt, States>,
    private readonly impl: Implementations<Ctx, Evt>,
  ) {}

  check(_m: Readonly<FsmModel<Ctx, States>>): boolean {
    // Every event is always applicable; invariants are asserted in run().
    return true;
  }

  run(m: FsmModel<Ctx, States>, r: Runtime<Ctx, Evt, States>): void {
    const before: Snapshot<Ctx, States> = r.getSnapshot();
    r.send(this.event);
    const after = r.getSnapshot();

    const predicted = step(this.def, before, this.event, this.impl);

    /* v8 ignore start — invariant guard: fires only when the live runtime
       diverges from the pure step() prediction, i.e. an internal bug. */
    if (predicted.snapshot.value !== after.value) {
      throw new Error(
        `aifsmjs/pbt: determinism violation — predicted "${String(predicted.snapshot.value)}" but runtime returned "${String(after.value)}" after ${this.toString()}`,
      );
    }
    /* v8 ignore stop */

    m.value = after.value;
    m.context = after.context as Ctx;
    m.status = after.status;
    m.reached.add(after.value);
  }

  toString(): string {
    // fc.stringify, not JSON.stringify: it never throws (BigInt, cycles,
    // Map/Set), so a failing counterexample stays readable.
    return `send(${fc.stringify(this.event)})`;
  }
}

/**
 * Build an `fc.Arbitrary` of FSM command sequences. Each command pulls one
 * event from the user-supplied arbitrary map and, when run, asserts that the
 * pure `step()` prediction matches the runtime's observable outcome.
 *
 * Pair this arbitrary with `fc.property(...)` inside a `fc.assert(...)` call,
 * or use the helpers in `aifsmjs/pbt` properties to get the six generic
 * invariants for free.
 */
export function commandsFromMachine<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
): fc.Arbitrary<Iterable<FsmCommand<Ctx, Evt, States>>> {
  const arbs: fc.Arbitrary<FsmCommand<Ctx, Evt, States>>[] = [];
  for (const arb of Object.values(eventArbitraries)) {
    arbs.push(arb.map((event) => new SendCommand(event, def, impl)));
  }
  return fc.commands(arbs, { size: "+1" });
}
