import type { MachineDef, TransitionConfig, TransitionDef } from "./types.js";

/**
 * Normalize a single transition config into its object form. The string
 * shorthand `"targetState"` (à la XState) becomes `{ target: "targetState" }`;
 * the object form is returned unchanged. Centralised here so every consumer
 * (`step`, `resolveTransitions`, `can`, validation) sees the same shape.
 *
 * @since 0.5.3
 */
export function normalizeTransition<Ctx, Evt, States extends string>(
  entry: TransitionConfig<Ctx, Evt, States>,
): TransitionDef<Ctx, Evt, States> {
  return typeof entry === "string" ? ({ target: entry } as TransitionDef<Ctx, Evt, States>) : entry;
}

/**
 * Normalize the raw `state.on[eventType]` value (object, string shorthand, or
 * an array mixing both) into an ordered list of {@link TransitionDef} objects.
 * Declaration order is preserved.
 *
 * @since 0.5.3
 */
export function normalizeTransitions<Ctx, Evt, States extends string>(
  entry:
    | TransitionConfig<Ctx, Evt, States>
    | readonly TransitionConfig<Ctx, Evt, States>[]
    | undefined,
): readonly TransitionDef<Ctx, Evt, States>[] {
  if (entry === undefined) return [];
  if (Array.isArray(entry)) {
    // Hot path (send/step/can run this per event): when no string shorthand is
    // present, return the original array instead of allocating a normalized copy.
    return entry.some((t) => typeof t === "string")
      ? entry.map((t) => normalizeTransition(t))
      : (entry as readonly TransitionDef<Ctx, Evt, States>[]);
  }
  return [normalizeTransition(entry as TransitionConfig<Ctx, Evt, States>)];
}

/**
 * Return all transition candidates for (state, eventType). Order is preserved
 * from the declaration so that guard fallthrough behaves predictably. String
 * shorthands are normalized to `{ target }` objects.
 *
 * If the event has no entry under the given state, an empty array is returned.
 */
export function resolveTransitions<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  stateValue: States,
  eventType: string,
): readonly TransitionDef<Ctx, Evt, States>[] {
  const state = def.states[stateValue];
  if (!state || !state.on) return [];
  return normalizeTransitions(state.on[eventType]);
}
