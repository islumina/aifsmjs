import { isAsyncGuardFn } from "./evaluator.js";
import { normalizeTransitions } from "./resolver.js";
import { createRuntime } from "./runtime.js";
import { freezeSnapshot } from "./snapshot.js";
import type {
  Implementations,
  MachineConfig,
  MachineDef,
  Runtime,
  RuntimeOptions,
  Snapshot,
  StateDef,
} from "./types.js";

/**
 * Thrown for an invalid machine definition and, since 0.6.0, for argument
 * misuse at the definition/runtime boundary (`defineMachine`,
 * `setup().defineMachine`, `createMachine`, `createRuntime`, and the
 * `send` / `reset` / `subscribe` / `on` / `onTransition` runtime methods).
 * Messages read `aifsmjs: <subject> must be <constraint>`.
 */
export class InvalidDefinitionError extends Error {
  constructor(message: string) {
    super(`aifsmjs: ${message}`);
    this.name = "InvalidDefinitionError";
  }
}

/** Throw `InvalidDefinitionError("<subject> must be an object")` unless `value` is a non-null object. */
export function assertObject(value: unknown, subject: string): void {
  if (value === null || typeof value !== "object") {
    throw new InvalidDefinitionError(`${subject} must be an object`);
  }
}

function validateDefinition<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  // Cycle guard: subs may reference each other (or themselves) by object
  // identity. We validate each distinct definition object at most once so a
  // self/mutually-referential sub graph terminates instead of recursing
  // forever (C2). Seeded by the public entry points below.
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (!def.id || typeof def.id !== "string") {
    throw new InvalidDefinitionError("definition must have a non-empty string `id`");
  }
  assertObject(def.states, "definition states");
  const stateKeys = Object.keys(def.states) as States[];
  if (stateKeys.length === 0) {
    throw new InvalidDefinitionError("`states` must declare at least one state");
  }
  if (!def.initial || !stateKeys.includes(def.initial)) {
    throw new InvalidDefinitionError(
      `\`initial\` "${String(def.initial)}" is not declared in states (${stateKeys.join(", ")})`,
    );
  }
  for (const [stateName, stateDef] of Object.entries(def.states) as [
    States,
    (typeof def.states)[States],
  ][]) {
    assertObject(stateDef, `state "${stateName}"`);
    // §4 sub-shape check + deep recursion (C2). The shallow shape check rejects
    // a malformed sub; recursing validateDefinition into the sub then rejects an
    // unknown transition target or a declared-async guard at construction
    // instead of leaving it to blow up at child.send(). Closes the FSM-07 sub
    // async-guard discrepancy (same root). The cycle guard makes this safe for
    // self/mutually-referential subs.
    if (stateDef.sub !== undefined) {
      const sub = stateDef.sub;
      const subStates = (sub as { states?: unknown }).states;
      const subInitial = (sub as { initial?: unknown }).initial;
      if (
        typeof sub !== "object" ||
        sub === null ||
        typeof subStates !== "object" ||
        subStates === null ||
        typeof subInitial !== "string" ||
        // initial must name one of the sub's own states — otherwise the child
        // boots pointing at a non-existent state and no-ops forever (FSM-S-02).
        !Object.hasOwn(subStates as object, subInitial)
      ) {
        throw new InvalidDefinitionError(
          `state "${stateName}".sub is not a valid sub-machine definition (missing states or initial)`,
        );
      }
      // Recurse — but only once per distinct sub object (cycle guard).
      if (!seen.has(sub as object)) {
        seen.add(sub as object);
        validateDefinition(sub as MachineDef<unknown, { type: string }, string>, seen);
      }
    }
    if (!stateDef.on) continue;
    for (const [evtType, entry] of Object.entries(stateDef.on)) {
      const transitions = normalizeTransitions(entry);
      for (const t of transitions) {
        assertObject(t, `transition ${stateName} -[${evtType}]->`);
        if (t.target !== undefined && !stateKeys.includes(t.target)) {
          throw new InvalidDefinitionError(
            `transition ${stateName} -[${evtType}]-> "${String(t.target)}" targets an unknown state`,
          );
        }
        if (t.guard !== undefined && isAsyncGuardFn(t.guard)) {
          throw new InvalidDefinitionError(
            `transition ${stateName} -[${evtType}]-> uses an async guard. Guards must be sync; move I/O into an effect.`,
          );
        }
      }
    }
  }
  // Initial-state sub chain (C2 cycle guard does not cover it): createRuntime
  // boots the child of every initial state eagerly, so a chain of initial-state
  // subs that revisits a definition would recurse until the stack overflows.
  // Runs once per distinct definition (root + each sub reached above). Subs
  // reachable only through non-initial states may still be self-referential.
  const path = new Set<object>();
  let d = def as MachineDef<unknown, { type: string }, string> | undefined;
  while (d) {
    if (path.has(d)) {
      throw new InvalidDefinitionError(
        `sub-machine cycle through initial states: "${d.id}" is re-entered via initial-state subs`,
      );
    }
    path.add(d);
    d = d.states[d.initial]?.sub;
  }
}

/**
 * Validate a machine definition shape and return it. When `context` is
 * provided the same reference is returned; when it is omitted a shallow copy
 * with `context: {}` is returned. Validation is intentionally shallow.
 *
 * Two call forms:
 *
 *   defineMachine<Ctx, Evt, States>({ ... })
 *     Explicit generics. Use when you need full control (e.g. union event
 *     types). Required because TypeScript cannot otherwise infer `Evt`.
 *
 *   setup<Ctx, Evt>().defineMachine({ ... })
 *     Curried form. Lets `States` be inferred from `keyof states`, so you
 *     can omit it. Recommended for typical usage.
 */
export function defineMachine<
  Ctx = Record<string, never>,
  Evt extends { type: string } = { type: string },
  States extends string = string,
>(def: MachineConfig<Ctx, Evt, States>): MachineDef<Ctx, Evt, States> {
  assertObject(def, "definition");
  const normalized = (
    def.context === undefined ? { ...def, context: {} as Ctx } : def
  ) as MachineDef<Ctx, Evt, States>;
  validateDefinition(normalized);
  return normalized;
}

/**
 * Curried builder so `States` can be inferred from `keyof states` without
 * `initial` or a transition `target` collapsing it to a single literal. Pass
 * `Ctx` and `Evt` as the type arguments; pass the def to the returned
 * `defineMachine`.
 *
 *   const machine = setup<MyCtx, MyEvt>().defineMachine({
 *     id: "m",
 *     initial: "a",
 *     context: { ... },
 *     states: { a: {...}, b: {...} },  // States inferred as "a" | "b"
 *   });
 */
export function setup<
  Ctx = Record<string, never>,
  Evt extends { type: string } = { type: string },
>(): {
  defineMachine: <const States extends string>(
    def: Readonly<{
      id: string;
      initial: NoInfer<States>;
      states: Readonly<{ [K in States]: StateDef<Ctx, Evt, NoInfer<States>> }>;
    }> &
      (Record<string, never> extends Ctx ? { readonly context?: Ctx } : { readonly context: Ctx }),
  ) => MachineDef<Ctx, Evt, States>;
} {
  // Same normalisation + validation as defineMachine; only the type-level
  // signature differs (States inferred from `keyof states`).
  return { defineMachine: defineMachine as never };
}

/**
 * Build the initial snapshot for a machine.
 */
export function initialSnapshot<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
): Snapshot<Ctx, States> {
  const isFinal = def.states[def.initial]?.final === true;
  return freezeSnapshot({
    value: def.initial,
    context: def.context,
    status: isFinal ? ("final" as const) : ("active" as const),
  });
}

/**
 * Convenience factory that composes `defineMachine` and `createRuntime` in
 * one call for the common case where you do not need to keep the machine
 * definition around for serialization or sharing.
 *
 * For type inference over `States` from `keyof states`, prefer
 * `setup<Ctx, Evt>().defineMachine(...)` then pass the result to
 * `createRuntime` separately. `createMachine` is the spec-style entry point
 * documented in the ai*js ecosystem review.
 */
export function createMachine<Ctx, Evt extends { type: string }, States extends string>(
  def: MachineDef<Ctx, Evt, States>,
  impl: Implementations<Ctx, Evt>,
  opts?: RuntimeOptions<Ctx, Evt, States>,
): Runtime<Ctx, Evt, States> {
  return createRuntime(defineMachine(def), impl, opts ?? {});
}
