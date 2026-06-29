import { isDeepStrictEqual } from "node:util";
import * as fc from "fast-check";
import { initialSnapshot } from "../fsm/definition.js";
import { step } from "../fsm/lifecycle.js";
import { normalizeTransitions } from "../fsm/resolver.js";
import { createRuntime } from "../fsm/runtime.js";
import type { Guard, Implementations, MachineDef } from "../fsm/types.js";
import { mergeContext } from "../fsm/updater.js";
import { replay } from "../replay/index.js";
import {
  type EventArbitraries,
  type FsmModel,
  commandsFromMachine,
  initialModel,
} from "./commands.js";

export type AssertOpts = Readonly<{
  numRuns?: number;
  seed?: number;
  verbose?: boolean;
}>;

function buildAssertOpts(opts: AssertOpts | undefined): fc.Parameters<unknown> {
  const out: fc.Parameters<unknown> = {};
  if (opts?.numRuns !== undefined) out.numRuns = opts.numRuns;
  if (opts?.seed !== undefined) out.seed = opts.seed;
  if (opts?.verbose) out.verbose = true;
  return out;
}

/**
 * Structural deep-equality for two context values (C3). Backed by `node:util`
 * `isDeepStrictEqual`, replacing the previous `JSON.stringify(a) === JSON.stringify(b)`
 * oracle which was unsound:
 *
 *   - key-order-sensitive  → false-FAIL on `{a:1,b:2}` vs `{b:2,a:1}`;
 *   - drops undefined keys  → false-PASS on `{v:undefined,w:1}` vs `{w:1}`;
 *   - lossy for `Map`/`Set`/`Date` (all serialise to `{}` or an ISO string);
 *   - throws on `BigInt`.
 *
 * `isDeepStrictEqual` distinguishes present-but-undefined from absent keys,
 * compares `Map`/`Set`/`Date` by contents, and tolerates `BigInt` — exactly
 * the verdicts a context-equality oracle for PBT requires. No new dependency
 * (Node built-in; the package already targets Node >=18).
 */
export function contextEquals(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

/**
 * #1 snapshotAlwaysFrozen — after any event sequence the live snapshot remains
 * frozen at the top level.
 */
export function snapshotAlwaysFrozen<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
  opts?: AssertOpts,
): void {
  fc.assert(
    fc.property(commandsFromMachine(def, impl, eventArbitraries), (cmds) => {
      const real = createRuntime(def, impl);
      const model: FsmModel<Ctx, States> = initialModel(def);
      fc.modelRun(() => ({ model, real }), cmds);
      return Object.isFrozen(real.getSnapshot());
    }),
    buildAssertOpts(opts),
  );
}

/**
 * #2 unknownEventNoOp — sending an event whose `type` is not declared in any
 * state's `on` map never changes the snapshot.
 */
export function unknownEventNoOp<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  unknownType: string,
  opts?: AssertOpts,
): void {
  fc.assert(
    fc.property(fc.constant(unknownType), (t) => {
      const initial = initialSnapshot(def);
      const result = step(def, initial, { type: t } as unknown as Evt, impl);
      return result.changed === false && result.snapshot === initial && result.effects.length === 0;
    }),
    buildAssertOpts(opts),
  );
}

/**
 * #3 reachableStatesSubsetDeclared — every state visited during a run belongs
 * to `def.states`.
 */
export function reachableStatesSubsetDeclared<
  Ctx,
  Evt extends { type: string },
  States extends string,
>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
  opts?: AssertOpts,
): void {
  const declared = new Set<string>(Object.keys(def.states));
  fc.assert(
    fc.property(commandsFromMachine(def, impl, eventArbitraries), (cmds) => {
      const real = createRuntime(def, impl);
      const model: FsmModel<Ctx, States> = initialModel(def);
      fc.modelRun(() => ({ model, real }), cmds);
      for (const s of model.reached as Set<string>) {
        /* v8 ignore next — property failure branch; an unreachable state would indicate a bug. */
        if (!declared.has(s)) return false;
      }
      return declared.has(real.getSnapshot().value);
    }),
    buildAssertOpts(opts),
  );
}

/**
 * #4 replayEqualsFold — `replay(initial, log)` produces the same final state
 * as a live runtime fed the same events. Effects dispatched by the runtime are
 * ignored; the comparison is on `{ value, context }`.
 */
export function replayEqualsFold<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
  opts?: AssertOpts,
): void {
  const eventArb = fc.oneof(...Object.values(eventArbitraries));
  fc.assert(
    fc.property(fc.array(eventArb, { maxLength: 32 }), (events) => {
      const real = createRuntime(def, impl, { dispatchEffects: false });
      for (const e of events) real.send(e);
      const live = real.getSnapshot();
      const replayed = replay(initialSnapshot(def), events, def, impl).snapshot;
      return live.value === replayed.value && contextEquals(live.context, replayed.context);
    }),
    buildAssertOpts(opts),
  );
}

/**
 * #5 guardsFalseNoTransition — when every candidate transition for the current
 * (state, event) pair carries a guard and every guard returns `false`, the
 * snapshot is unchanged (`changed === false`).
 *
 * Implementation: synthesise an impl that forces every guard to `false`, then
 * for each step whose candidate list is fully guarded, assert the step did not
 * change state. Steps with an unguarded fallback candidate (which fires even
 * when all guards are false) are skipped — the README claim is specifically
 * about the all-guards-false case.
 */
export function guardsFalseNoTransition<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
  opts?: AssertOpts,
): void {
  const blockedGuards = new Proxy(
    {},
    {
      get: () => () => false,
    },
  ) as Readonly<Record<string, Guard<Ctx, Evt>>>;
  const blockedImpl: Implementations<Ctx, Evt> = {
    ...impl,
    guards: blockedGuards,
  };
  // True when every candidate transition for (value, eventType) carries a
  // guard — i.e. blocking all guards leaves no unconditional fallback, so a
  // correct step() must report changed === false.
  const isFullyGuarded = (value: States, eventType: string): boolean => {
    const candidates = normalizeTransitions(def.states[value]?.on?.[eventType]);
    return candidates.length > 0 && candidates.every((t) => t.guard !== undefined);
  };
  fc.assert(
    fc.property(
      fc.array(fc.oneof(...Object.values(eventArbitraries)), { maxLength: 16 }),
      (events) => {
        let snap = initialSnapshot(def);
        for (const e of events) {
          const fullyGuarded = isFullyGuarded(snap.value, e.type);
          const r = step(def, snap, e, blockedImpl);
          // The named invariant: all guards false + no unconditional fallback
          // ⇒ no transition. Without this assertion the property was vacuous
          // (it only failed if step() threw).
          if (fullyGuarded && r.changed !== false) return false;
          snap = r.snapshot;
        }
        return true;
      },
    ),
    buildAssertOpts(opts),
  );
}

/**
 * #6 assignDoesNotMutate — running an `assign`-style action never mutates the
 * previous context object. Verified by deep-equality check on a snapshot taken
 * before each event.
 */
export function assignDoesNotMutate<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
  opts?: AssertOpts,
): void {
  // Quick sanity guard: mergeContext is the only context mutator used by step.
  const dummy = { a: 1, b: 2 };
  const merged = mergeContext(dummy, { b: 3 });
  /* v8 ignore next — invariant guard; mergeContext returning the same ref would mean unit tests have already broken. */
  if (merged === dummy) throw new Error("aifsmjs/pbt: mergeContext returned the same reference");

  fc.assert(
    fc.property(
      fc.array(fc.oneof(...Object.values(eventArbitraries)), { maxLength: 16 }),
      (events) => {
        let snap = initialSnapshot(def);
        for (const e of events) {
          // Structural snapshot of the pre-step context (C3). structuredClone +
          // contextEquals replaces the old JSON.stringify round-trip, which was
          // lossy for Map/Set/Date and threw on BigInt. structuredClone produces
          // an independent copy so a subsequent in-place mutation by step() is
          // detectable by deep comparison.
          const beforeCtx = structuredClone(snap.context);
          step(def, snap, e, impl);
          /* v8 ignore next — property failure branch; step() mutating snap.context would indicate a bug. */
          if (!contextEquals(snap.context, beforeCtx)) return false;
          // Continue with the actual result for subsequent events
          snap = step(def, snap, e, impl).snapshot;
        }
        return true;
      },
    ),
    buildAssertOpts(opts),
  );
}

/**
 * Assert every generic property in one call. Use this when you don't need
 * fine-grained control over per-property options.
 */
export function assertAll<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  eventArbitraries: EventArbitraries<Evt>,
  opts?: AssertOpts & { unknownEventType?: string },
): void {
  snapshotAlwaysFrozen(def, impl, eventArbitraries, opts);
  unknownEventNoOp(def, impl, opts?.unknownEventType ?? "__AIFSMJS_UNKNOWN__", opts);
  reachableStatesSubsetDeclared(def, impl, eventArbitraries, opts);
  replayEqualsFold(def, impl, eventArbitraries, opts);
  guardsFalseNoTransition(def, impl, eventArbitraries, opts);
  assignDoesNotMutate(def, impl, eventArbitraries, opts);
}
