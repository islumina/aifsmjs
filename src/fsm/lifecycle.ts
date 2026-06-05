import { createEnqueuer } from "../effects/enqueuer.js";
import { evalGuard } from "./evaluator.js";
import { normalizeTransitions } from "./resolver.js";
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

function resolveAction<Ctx, Evt>(
  ref: ActionRef<Ctx, Evt>,
  impl: Implementations<Ctx, Evt>,
): Action<Ctx, Evt> {
  if (typeof ref === "function") return ref;
  const fn = impl.actions?.[ref];
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
    current = mergeContext(current, patch);
  }
  return current;
}

function pickTransition<Ctx, Evt, States extends string>(
  candidates: readonly TransitionDef<Ctx, Evt, States>[],
  ctx: Ctx,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
  value: States,
): TransitionDef<Ctx, Evt, States> | undefined {
  for (const t of candidates) {
    if (!t.guard) return t;
    if (evalGuard(t.guard, ctx, event, impl, value)) return t;
  }
  return undefined;
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
 */
export function step<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  snapshot: Snapshot<Ctx, States>,
  event: Evt,
  impl: Implementations<Ctx, Evt>,
): StepResult<Ctx, States> {
  // Final state is inert: it never reacts to events.
  if (snapshot.status === "final") {
    return Object.freeze({ snapshot, effects: [] as readonly Effect[], changed: false });
  }

  const state = def.states[snapshot.value];
  /* v8 ignore next 3 — defensive: snapshot.value is always validated against def.states by defineMachine + initialSnapshot. */
  if (!state) {
    return Object.freeze({ snapshot, effects: [] as readonly Effect[], changed: false });
  }

  const candidateList = normalizeTransitions(state.on?.[event.type]);

  const chosen = pickTransition(candidateList, snapshot.context, event, impl, snapshot.value);
  if (!chosen) {
    return Object.freeze({ snapshot, effects: [] as readonly Effect[], changed: false });
  }

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

  return Object.freeze({
    snapshot: nextSnapshot,
    effects: Object.freeze(effectSink.slice()) as readonly Effect[],
    changed: true,
  });
}
