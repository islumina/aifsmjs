import { createEnqueuer } from "../effects/enqueuer.js";
import { evalGuard, ownValue } from "./evaluator.js";
import { resolveTransitions } from "./resolver.js";
import { freezeSnapshot } from "./snapshot.js";
import type {
  Action,
  ActionRef,
  Effect,
  Implementations,
  MachineDef,
  Snapshot,
  StepResult,
  TransitionDef,
} from "./types.js";
import { mergeContext } from "./updater.js";

export class UnknownActionError extends Error {
  readonly actionName: string;
  constructor(actionName: string) {
    super(`aifsmjs: action "${actionName}" not found in implementations.actions`);
    this.name = "UnknownActionError";
    this.actionName = actionName;
  }
}

/**
 * Thrown (from `step()`, and so from `send()` before anything is committed)
 * when an action returns a non-nullish primitive (`false`, `0`, `""`, ...) as
 * the patch for an object context. An object context accepts only a
 * plain-object patch or `undefined`/`null` (no change).
 *
 * `actionName` is the string ref, the inline function's name, or `"<inline>"`
 * for an anonymous inline action (mirrors guard naming).
 *
 * @since 0.6.0
 */
export class InvalidActionResultError extends Error {
  readonly actionName: string;
  constructor(actionName: string, patch: unknown) {
    super(
      `aifsmjs: action "${actionName}" returned ${typeof patch}; an object context accepts only a plain-object patch (or undefined)`,
    );
    this.name = "InvalidActionResultError";
    this.actionName = actionName;
  }
}

function resolveAction<Ctx, Evt>(
  ref: ActionRef<Ctx, Evt>,
  impl: Implementations<Ctx, Evt>,
): Action<Ctx, Evt> {
  if (typeof ref === "function") return ref;
  const fn = ownValue(impl.actions, ref);
  if (!fn) throw new UnknownActionError(ref);
  return fn;
}

function runActions<Ctx, Evt>(
  refs: readonly ActionRef<Ctx, Evt>[] | undefined,
  ctx: Ctx,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
  effectSink: Effect[],
): Ctx {
  if (!refs || refs.length === 0) return ctx;
  const enqueue = createEnqueuer(effectSink as { type: string; payload?: unknown }[]);
  let current = ctx;
  for (const ref of refs) {
    const fn = resolveAction(ref, impl);
    const patch = fn({ context: current, event, enqueue });
    current = mergeContext(current, patch, typeof ref === "string" ? ref : fn.name || "<inline>");
  }
  return current;
}

/**
 * The transition `event` would fire from `snapshot`: the first candidate (in
 * declaration order) with no guard or a passing guard, or `undefined` (also
 * for a final state, which never reacts). Shared by `step()` and
 * `Runtime.can()` so both resolve candidates the same way.
 */
export function chooseTransition<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  snapshot: Snapshot<Ctx, States>,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
): TransitionDef<Ctx, Evt, States> | undefined {
  if (snapshot.status === "final") return undefined;
  for (const t of resolveTransitions(def, snapshot.value, event.type)) {
    if (!t.guard || evalGuard(t.guard, snapshot.context, event, impl, snapshot.value)) return t;
  }
  return undefined;
}

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

/**
 * Internal `step()` that also reports whether the chosen transition is
 * external (has a `target`, including a same-value self-target). The runtime
 * uses it to decide the sub-machine lifecycle from the SAME guard pass that
 * produced the snapshot, so a non-idempotent guard is evaluated exactly once
 * per event. Not re-exported from the package root.
 */
export function stepWithMeta<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  snapshot: Snapshot<Ctx, States>,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
): { result: StepResult<Ctx, States>; external: boolean } {
  // Nothing fires for a final state (inert), an undeclared event type, or
  // when every candidate's guard fails.
  const chosen = chooseTransition(def, snapshot, event, impl);
  if (!chosen) {
    return {
      result: Object.freeze({ snapshot, effects: NO_EFFECTS, changed: false }),
      external: false,
    };
  }
  // A chosen transition implies snapshot.value is a declared state.
  const state = def.states[snapshot.value];

  const isExternal = chosen.target !== undefined;
  const nextStateValue = (chosen.target ?? snapshot.value) as States;
  const nextState = def.states[nextStateValue];

  const effectSink: Effect[] = [];
  let ctx = snapshot.context;

  if (isExternal) {
    ctx = runActions(state.exit, ctx, event, impl, effectSink);
  }
  ctx = runActions(chosen.actions, ctx, event, impl, effectSink);
  if (isExternal && nextState) {
    ctx = runActions(nextState.entry, ctx, event, impl, effectSink);
  }

  const status: "active" | "final" = nextState?.final === true ? "final" : "active";
  const nextSnapshot = freezeSnapshot({
    value: nextStateValue,
    context: ctx,
    status,
  });

  return {
    result: Object.freeze({
      snapshot: nextSnapshot,
      effects: Object.freeze(effectSink.slice()) as readonly Effect[],
      changed: true,
    }),
    external: isExternal,
  };
}

/**
 * Compute the next snapshot and collected effects from a single event.
 *
 * Order is fixed and uninterruptible:
 *   1. resolve candidate transitions for (state, event.type)
 *   2. evaluate guards in declaration order; pick the first passing one
 *   3. if external (target defined), run exit actions of the old state
 *   4. run transition.actions in declaration order
 *   5. if external, run entry actions of the new state
 *   6. return { snapshot, effects, changed }
 *
 * The function is pure: it never dispatches effects and never mutates inputs.
 * Each guard on the path is evaluated at most once.
 */
export function step<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  snapshot: Snapshot<Ctx, States>,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
): StepResult<Ctx, States> {
  return stepWithMeta(def, snapshot, event, impl).result;
}
