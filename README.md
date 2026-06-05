# aifsmjs

[![npm version](https://img.shields.io/npm/v/aifsmjs.svg)](https://www.npmjs.com/package/aifsmjs)
[![CI](https://github.com/yshengliao/aifsmjs/actions/workflows/ci.yml/badge.svg)](https://github.com/yshengliao/aifsmjs/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)
[![AI Generated](https://img.shields.io/badge/AI_Generated-Claude_Code_Opus_4.7_Max-blueviolet.svg)](https://www.anthropic.com/claude-code)
[![繁體中文](https://img.shields.io/badge/lang-繁體中文-red.svg)](README_ZHTW.md)

> A small, strict FSM library for any TypeScript/JS app that needs deterministic, replayable state transitions. Lifecycle is a pure `step()` function. Chain-of-Responsibility intuition is reserved for cross-cutting concerns (observe / persist / replay), never for the transition core.

Part of the [ai\*js micro-runtime ecosystem](https://github.com/yshengliao) — see also [aibridgejs](https://github.com/yshengliao/aibridgejs) (cross-context RPC) and [aiecsjs](https://github.com/yshengliao/aiecsjs) (ECS).

**Primary audience**: developers building stateful flows — multi-step forms, checkout funnels, auth flows, tutorial sequences, document-status workflows, scene flow in interactive apps, and the same patterns in browser-based games (PixiJS / Svelte 5 / plain Canvas / WebGL). The core is **environment-neutral** (pure function + adapter boundary): browser, Node, Bun, Deno, Flutter WebView, and Web Workers all work. The Roadmap section keeps gaming-specific niceties (tick hook, ECS bridge) as opt-in subpaths, not core surface.

---

## Why aifsmjs

Developers coming from C# Chain-of-Responsibility instinctively wrap FSM lifecycle in a cancellable middleware chain. In FSM territory that breaks determinism and replay. Web games in particular need replayable, serializable, worker-friendly state, so aifsmjs goes the other way:

- **Lifecycle is a pure function**: `step(def, snapshot, event, impl)` runs `guards → exit → action → entry` in a fixed, uninterruptible order.
- **CoR intuition is reserved for cross-cutting layers**: `inspect/` provides a Koa-style middleware pipeline, but it can only observe — **never alter the transition outcome**.
- **Definition is plain data**: guards / actions / effects are referenced by string; implementations are injected only at runtime. Serializable, transferable across Web Workers, persistable to a database.
- **PBT is first-class**: built-in `fast-check` `fc.commands` adapter plus 6 generic property tests. No comparable library currently ships this.

In ecosystem terms: closer to Robot3's functional composition + XState v5's `and/or/not` guard combinators + `@xstate/store` v3's `enq.effect()` dual-track side effects. The core measures ~2.8KB ESM gzipped (v0.1.0); every opt-in subpath is independently tree-shakeable.

---

## Quick Start

```bash
pnpm add aifsmjs
```

```typescript
import { setup, createRuntime, assign } from "aifsmjs";

type Ctx = { ticks: number };
type Evt = { type: "NEXT" };

// 1. Definition is plain data; setup<Ctx, Evt>() lets States be inferred from
//    the keys of `states`, so you don't have to repeat them.
const trafficLight = setup<Ctx, Evt>().defineMachine({
  id: "trafficLight",
  initial: "red",
  context: { ticks: 0 },
  states: {
    red:    { on: { NEXT: { target: "green",  actions: ["bump"] } } },
    green:  { on: { NEXT: { target: "yellow", actions: ["bump"] } } },
    yellow: { on: { NEXT: { target: "red",    actions: ["bump"] } } },
  },
});

// 2. Implementations are injected only at runtime
const runtime = createRuntime(trafficLight, {
  actions: {
    bump: assign(({ context }) => ({ ticks: context.ticks + 1 })),
  },
});

// 3. Interact
runtime.send({ type: "NEXT" });
console.log(runtime.getSnapshot().value);   // "green"
console.log(runtime.getSnapshot().context); // { ticks: 1 }
```

> The bare `defineMachine<Ctx, Evt, States>({...})` form is still available as an escape hatch when you need explicit control over union event types. In normal cases prefer `setup().defineMachine()`.

---

## Mental Model

```
┌──────────────────────┐       ┌──────────────────────┐
│  MachineDefinition   │       │   Implementations    │
│  (plain data, JSON)  │  +    │   (guards/actions/    │
│  • states            │       │    effects fn map)   │
│  • on / target       │       │                      │
│  • string refs       │       │                      │
└──────────┬───────────┘       └──────────┬───────────┘
           │                              │
           └──────────────┬───────────────┘
                          ▼
              ┌────────────────────────┐
              │  step(def, snap, evt,  │  ← pure function
              │       impl)            │     fixed order, uninterruptible
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │   { snapshot,          │
              │     effects: [...] }   │     caller decides when
              └───────────┬────────────┘     to dispatch effects
                          ▼
              ┌────────────────────────┐
              │  createRuntime(...)    │  ← thin wrapper
              │  state holder + send   │
              └────────────────────────┘
```

The three layers are fully decoupled: take `step()` alone for replay, take `MachineDefinition` alone for visualization, and `createRuntime` is just the convenience layer that glues them.

---

## Capabilities / Limitations

| Will do (v1)                                        | Won't do                                          |
| --------------------------------------------------- | ------------------------------------------------- |
| Flat states + transitions                           | Parallel state regions                            |
| Hierarchical sugar via `state.sub` (stable since 0.4.0) | Closures embedded in definition (breaks serialize) |
| Guards (sync only; inline async throws `InvalidDefinitionError` at `defineMachine`; runtime throws `AsyncGuardError` on thenable return) | Async guards                                      |
| Actions (assign + enqueue effects)                  | Async API inside an action (use an effect)        |
| Fire-and-forget effects                             | Actor invocation / spawn                          |
| Read-only inspect middleware                        | Cancellable transition middleware                 |
| `replay(initial, log, def, impl)` pure function     | Time-travel debugger (v2 candidate)               |
| `fast-check` `fc.commands` adapter                   | Custom PBT framework                               |
| String ref + runtime injection                      | Single root import for everything                 |
| Tree-shake friendly subpath exports                  | ECS / Pixi bridges (opt-in subpath, not core)     |

---

## Design Philosophy

<details>
<summary>Why lifecycle cannot be middleware (click to expand)</summary>

UML statecharts and SCXML both mandate `exit → transition action → entry` as an atomic sequence. The moment a middleware handler can call `next()` or throw to abort, you can land in an invalid state — "entered the new state but never exited the old one" — which destroys:

1. **Determinism**: the same event sequence no longer guarantees the same snapshot.
2. **Replay**: event logs cannot reproduce the same outcome in another environment.
3. **PBT shrinking**: fast-check's counter-example minimization presumes a deterministic machine.

XState v5 removed the `predictableActionArguments` flag (actions are now always predictable) precisely because of this lesson from v4. Spring StateMachine flags its cancellable Interceptor as a "relatively deep internal feature" for the same reason.

So aifsmjs splits the CoR chain instinct two ways:

| Use case                       | How it is handled                                       |
| ------------------------------ | ------------------------------------------------------- |
| Chained guard predicates       | `and/or/not` higher-order combinators                   |
| Multi-step action sequencing   | `actions: [...]` array, runs in order to completion     |
| Cross-cutting (log/persist)    | `inspect/` middleware — read-only, no cancel ability    |

</details>

<details>
<summary>Why the definition is plain data</summary>

The moment definitions contain closures, you lose:

- `JSON.stringify` round-trip for DB / localStorage persistence
- `postMessage` transfer to a Web Worker
- Static reachability analysis by a visualizer tool
- Auto-generated event arbitraries from a PBT adapter

aifsmjs follows the XState v5 two-phase pattern (`setup().createMachine()`): the definition uses string refs; the function map is injected at `createRuntime()`. Inline functions are still allowed but flagged as an escape hatch.

</details>

---

## Core API

### `defineMachine<C, E, S>(def)`

```typescript
function defineMachine<
  Ctx = Record<string, never>,
  Evt extends { type: string } = { type: string },
  States extends string = string,
>(def: MachineConfig<Ctx, Evt, States>): MachineDef<Ctx, Evt, States>;
```

Pure data builder. Validates that `initial` exists in the `states` map and returns the (normalized) definition.

`context` is **optional** — omit it for stateless machines and it defaults to `{}` (the type parameter defaults to `Record<string, never>`). Existing definitions that pass `context` are unaffected.

```typescript
// No context needed — defaults to {}
const toggle = defineMachine({
  id: "toggle",
  initial: "off",
  states: {
    off: { on: { TOGGLE: "on" } },   // string shorthand, see below
    on:  { on: { TOGGLE: "off" } },
  },
});
```

**String-shorthand transitions.** A transition value may be either the full object form or a bare target-state string (à la XState). The string is normalized to `{ target }` before processing — it carries no guard or actions:

```typescript
on: { NEXT: "green" }                 // shorthand for { target: "green" }
on: { NEXT: [{ target: "a", guard: "g" }, "b"] }  // mixes with the object form
```

### `createRuntime(def, impl, opts?)`

```typescript
function createRuntime<C, E, S>(
  def: MachineDef<C, E, S>,
  impl: Implementations<C, E>,
  opts?: { middleware?: readonly Middleware<C, E, S>[] },
): Runtime<C, E, S>;

interface Runtime<C, E, S> {
  getSnapshot(): Snapshot<C, S>;
  send(event: E): Snapshot<C, S>;
  subscribe(listener: (snap: Snapshot<C, S>) => void): () => void;
  reset(event?: E): Snapshot<C, S>;
  dispose(): void;
  readonly disposed: boolean;
  readonly signal: AbortSignal;
}
```

Thin wrapper. Internally calls `step()` and dispatches effects. `dispose()` aborts the built-in `AbortController`, clears listeners, and causes subsequent `send()` / `reset()` calls to throw `RuntimeDisposedError`. `reset()` rewinds the snapshot to `initialSnapshot(def)` and notifies subscribers, but **does not run entry actions** — reset is "the runtime is reborn", not a transition.

`runtime.signal` is the runtime's lifetime signal; it fires once on dispose. Every `EffectHandler` receives it via `args.signal`. External integrations (React unmount, game scene teardown) can attach `runtime.signal.addEventListener("abort", ...)` to chain their own cleanup.

### `step(def, snapshot, event, impl)`

```typescript
function step<C, E, S>(
  def: MachineDef<C, E, S>,
  snapshot: Snapshot<C, S>,
  event: E,
  impl: Implementations<C, E>,
): { snapshot: Snapshot<C, S>; effects: readonly Effect[] };
```

**Pure function**. The invariant keeper for the whole library. It never dispatches effects and never mutates the snapshot. A failing guard or unmapped event simply returns the original snapshot unchanged. It does throw on misuse (`UnknownGuardError`, `UnknownActionError`, `AsyncGuardError`) so guard/action wiring errors surface at development time rather than silently passing.

### `assign(updater)`

```typescript
function assign<C, E>(
  updater: (args: { context: C; event: E }) => Partial<C>,
): Action<C, E>;
```

Pure context update helper. Returns a partial that is merged into the context. No side effects.

---

## Opt-in Modules

Each opt-in lives on its own subpath. If you don't import it, it is fully tree-shaken away.

### `aifsmjs/guards` — Guard combinators

```typescript
import { and, or, not, stateIn } from "aifsmjs/guards";

const canCheckout = and([
  "isAuthenticated",
  or(["isAdmin", "isOwner"]),
  not("isBanned"),
]);
```

`and/or/not` short-circuit over sync guards. `stateIn(...states)` is a sugar predicate: "current state is one of these".

### `aifsmjs/effects` — Fire-and-forget effects

```typescript
import { type Action } from "aifsmjs";

const checkout: Action<Ctx, Evt> = ({ context, enqueue }) => {
  enqueue.effect("trackAnalytics", { event: "checkout", ctx: context });
  // Return value becomes the new context (omit to keep current context)
};
```

`enqueue.effect(type, payload)` queues a side-effect declaration. `step()` collects them and hands them back to the caller. Runtime dispatches after the transition; replay mode disables dispatch and keeps only the snapshot fold.

### `aifsmjs/inspect` — Read-only middleware

```typescript
import { createRuntime } from "aifsmjs";
import { logger, persist } from "aifsmjs/inspect";

const runtime = createRuntime(def, impl, {
  middleware: [
    logger(console.log),
    persist({ key: "machine-state", storage: localStorage }),
  ],
});
```

Koa-style `(ctx, next) => void` pipeline. `ctx` is `{ prev, next, event, effects, changed }`, all deep-frozen. **Cannot cancel a transition** — `next()` must be called; the return value carries no meaning.

### `aifsmjs/replay` — Pure event log replay

```typescript
import { replay } from "aifsmjs/replay";

const finalSnap = replay(initialSnapshot, eventLog, def, impl);
// Equivalent to eventLog.reduce((s, e) => step(def, s, e, impl).snapshot, initial)
```

Never dispatches effects. For PBT, time-travel debugging, and incident reproduction.

### `aifsmjs/pbt` — fast-check adapter

> **Install the peer**: `pnpm add -D fast-check` (^3.20.0). aifsmjs lists fast-check as an optional peer; you only need it when importing this subpath.

```typescript
import fc from "fast-check";
import { createRuntime } from "aifsmjs";
import { commandsFromMachine, initialModel, properties } from "aifsmjs/pbt";

// Use one of the six built-in generic properties, or assertAll for all at once:
properties.replayEqualsFold(def, impl, {
  NEXT: fc.constant({ type: "NEXT" as const }),
});

// Or build a custom property using commandsFromMachine:
fc.assert(
  fc.property(
    commandsFromMachine(def, impl, {
      NEXT: fc.constant({ type: "NEXT" as const }),
    }),
    (cmds) => {
      const real = createRuntime(def, impl, { dispatchEffects: false });
      fc.modelRun(() => ({ model: initialModel(def), real }), cmds);
      return true;
    },
  ),
);
```

`properties.*` ships 6 generic properties (see [Testing Strategy](#testing-strategy)). `fast-check` is `peerDependenciesMeta.optional`; no install penalty if you don't use it.

### `aifsmjs/timer` — Cancellable delayed callbacks

```typescript
import { after, createScheduler } from "aifsmjs/timer";

// One-shot
const handle = after(5000, () => runtime.send({ type: "TIMEOUT" }));
handle.cancel(); // cancels if not yet fired

// AbortSignal integration
const ac = new AbortController();
after(5000, () => runtime.send({ type: "TIMEOUT" }), { signal: ac.signal });
ac.abort(); // also cancels

// Scheduler: bundle a group of timers and cancel them together on teardown
const sched = createScheduler();
sched.after(1000, () => {});
sched.after(2000, () => {});
sched.cancelAll();
```

- Thin wrapper over `setTimeout` / `clearTimeout`, with injectable timer functions (validated by vitest fake timers)
- AbortSignal listener registered with `{ once: true }` to avoid leaks
- Decoupled from the FSM core: you decide when to forward a fired timer as `runtime.send(...)`

---

## Lifecycle Invariants

The fixed order inside `step()` (always, no escape hatch):

```
1. resolveTransitions(def, snapshot.value, event)
       → candidate transitions for (state, event)
2. evaluate guard on each candidate in declaration order
       → first passing transition is chosen; otherwise the original snapshot is returned
3. exit actions of the old state         (v1 is flat, no hierarchy)
4. transition.actions[] run in declaration order
       → each action may call enqueue.effect()
       → each action's returned partial context is merged into the current context
5. entry actions of the new state
6. return { snapshot, effects } — the caller decides when to dispatch effects
```

**Contracts**:

Guarantees:

- Guards are sync and pure (never mutate context)
- Actions always run to completion (no cancel mechanism)
- Effects are declarations (type + payload), not callbacks — serializable
- Snapshot is immutable; dev mode deep-freezes for diagnostics, prod is shallow for speed

Non-goals:

- No async lifecycle hook
- Inspect middleware cannot alter the transition outcome

### Sub-machine lifecycle (stable since 0.4.0)

When a state declares `sub`, the per-transition ordering is:

1. Parent `step()` runs: `exit actions → transition.actions → entry actions`.
2. Old child (if any) `dispose()` — synchronous; exceptions become
   `SubMachineError(phase: "dispose")`.
3. New child (if next state has `sub`) instantiation — exceptions become
   `SubMachineError(phase: "init")`.
4. Parent snapshot commits.
5. Middleware pipeline runs.
6. Effects dispatch.
7. `'transition'` event emits to `on()` / `onTransition()` subscribers.

If step 2 or 3 throws, the parent snapshot is **not** committed (rollback
to `prev`); no middleware / effects / `'transition'` runs.

`runtime.dispose()` cascades to the child via `controller.signal`'s abort
listener and an explicit `child.dispose()` call. Cascade swallows child
exceptions to honour the never-throws dispose contract.

---

## Lifecycle Protocol

aifsmjs is the first package in a "minimal AI toolchain" family. This lifecycle protocol is meant to be reused by future packages (`aitaskjs / aibridgejs / aiaudiojs` and friends):

| Verb | aifsmjs equivalent | Semantics |
|---|---|---|
| `createX()` | `createRuntime` / `createScheduler` / `defineMachine` / `setup` | Factory function returning the instance |
| `dispose()` | `runtime.dispose()` / `scheduler.cancelAll()` | Release resources; idempotent; post-dispose API throws a known error |
| `reset()` | `runtime.reset()` | Zero out state without releasing resources |
| `on/off` | `runtime.subscribe(fn)` returning an unsubscribe fn | Subscription pattern; explicit unsubscribe |
| `AbortSignal` | `runtime.signal` / `after(_, _, { signal })` | Cancellation channel for any long-running / async work |
| Pure core | `step()` | No I/O, serializable, replayable |
| Explicit errors | `RuntimeDisposedError` / `UnknownGuardError` / `UnknownActionError` / `InvalidDefinitionError` | Named error classes, never bare `throw "string"` |

When future ai\*js packages ask "should this have a dispose?" or "where does the signal plug in?", this table is the baseline.

---

## Design choices: divergence from common patterns

aifsmjs ships a few opinionated calls that look different from the typical FSM library. The rationale below explains what we chose and why, so readers coming from XState, statecharts, or general event-emitter libraries can skip the source dive.

- **`send()` is synchronous, returning `Snapshot` instead of `Promise<Snapshot>`.** The pure `step()` core is sync by construction so that `replay(initial, log)` and PBT shrinking remain trivial. Effect handlers may still be async; the runtime fires them and forwards async rejections to the `'error'` event channel. If you need to await effect completion, build a small wrapper that returns `Promise.all` over your handler results.
- **Guards and reducers are sync.** A non-deterministic guard would break the PBT determinism property (#1 in the generic suite). Move async predicates into events: send `FETCH_REQUEST`, then later `FETCH_DONE` with the resolved value as payload.
- **Effects are descriptors, not inline callbacks.** Actions enqueue `{ type, payload }` via `enqueue.effect(...)`; the runtime collects them and the dispatcher invokes user handlers. This keeps machine definitions serializable (JSON round-trippable when no inline functions are used), enables `replay()` to fold an event log into the same snapshot, and lets `inspect/persist` middleware capture effects for audit logs.
- **Two factory paths coexist.** `setup<Ctx, Evt>().defineMachine(...)` is the type-friendly form (States inferred from `keyof states`). `createMachine(def, impl, opts?)` is the spec-style single-factory shortcut from the ai*js ecosystem review. Plain `defineMachine<Ctx, Evt, States>(def)` remains for explicit generic control. Pick whichever reads best at the call site.
- **Transitions accept a string shorthand.** `on: { EVENT: "targetState" }` is sugar for `on: { EVENT: { target: "targetState" } }`, normalized in the resolver before any guard/action processing. The shorthand has no guard or actions; reach for the object form when you need them. It composes inside the array form too, so guard-fallthrough lists can mix `{ target, guard }` objects with bare target strings. The full object form is unchanged — this is purely additive.
- **`context` is optional.** Omit it for stateless machines and it defaults to `{}` (`Ctx` defaults to `Record<string, never>`). Definitions that already pass `context` keep their inferred type and behave identically.
- **`subscribe(listener)` and `on(type, fn, { signal, once })` both exist.** The typed `on()` matches the platform `EventTarget` semantics (signal + once) and emits `'transition'`, `'error'`, `'dispose'`. The older `subscribe()` keeps the React `useSyncExternalStore` shape — pass it directly. They are not exclusive.

---

## AI-Agent Reading Guide

> This section is for LLMs and code-search agents. Invariants, types, and misuse patterns are concentrated here.

### Serializable fields

The following are plain data, safe to `JSON.stringify` round-trip:

- The entire `MachineDef` (provided no inline functions are used)
- The entire `Snapshot` (provided `context` is plain data)
- The entire `Effect` (`{ type: string; payload?: unknown }`)

The following are **not serializable** and will break PBT/replay:

- Every function inside `Implementations`
- Middleware closures

### Invariants (do not violate)

1. `step()` is pure: identical `(def, snapshot, event, impl)` always returns identical `{ snapshot, effects }`.
2. Snapshots are frozen: in dev mode any mutation throws immediately.
3. Guards never mutate context: violators are caught by PBT property #2.
4. Effects are always fire-and-forget: the runtime never waits for an effect before updating the snapshot.
5. `dispose()` is idempotent; post-dispose `send()` / `reset()` throws `RuntimeDisposedError`.
6. `runtime.signal.aborted` is `true` for the rest of time once disposed; the effect handler's `signal` is the same one.
7. `reset()` only resets the snapshot and notifies listeners — it does **not** run entry actions. Listeners are notified only when `prev.value !== initial.value` (parity with `send()`). Middleware always observes the call (possibly with `changed: false`).
8. `MiddlewareContext.event` is typed `Evt | ResetEvent`; a `reset()` without an event injects the `RESET_EVENT_TYPE` sentinel (`"@@aifsmjs/RESET"`).

### Common misuses

| Anti-pattern                                              | Correct form                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| Calling `fetch()` (or any async API) inside a guard        | Rewrite as events: send `FETCH_REQUEST`, then `FETCH_DONE`    |
| `setTimeout`-and-mutate inside an action                   | Use `enqueue.effect("delayedThing", ...)`                     |
| Using middleware to alter the next state                   | Not possible — middleware is read-only. Rewrite as a guard.   |
| Inline functions inside a definition (works but breaks serialize) | Pull out as string refs, inject at `createRuntime`            |

### Machine-readable schema

A JSON schema for `MachineDef` will ship at `dist/schema/machine.schema.json`. Not yet available in v1; types live in [src/fsm/types.ts](src/fsm/types.ts) for agents to derive from.

---

## Testing Strategy

Example-first, PBT-augmented. Lesson from jssm: "3000+ tests / 100% coverage" turns out to have < 12% coverage from stochastic tests — the rest is example specs.

- **Example tests** (vitest): for every src module, write happy path + edge + error-message triplets.
- **PBT smoke**: each generic property runs 50 iterations as an invariant guard, not as a coverage source.
- **CI-enforced thresholds**: `@vitest/coverage-v8` is wired to **100% statements / 100% lines / 100% functions / ≥90% branches**. The few defensive invariant-guard branches (e.g. runtime determinism mismatch) carry `/* v8 ignore */` annotations with rationale.
- **Size budget**: `scripts/check-size.mjs` enforces per-subpath gzip caps in CI — core ≤4.7 KB (raised in 0.3.0 for sub-machine sugar), replay ≤1.8 KB, pbt ≤5.5 KB (raised in 0.3.0 because `pbt` transitively imports `createRuntime`), others ≤1 KB. Exceeding any cap fails the build.

### The 6 built-in generic properties

| #   | Property                          | One-liner                                                |
| --- | --------------------------------- | -------------------------------------------------------- |
| 1   | snapshotAlwaysFrozen              | After any event sequence, the snapshot remains frozen    |
| 2   | unknownEventNoOp                  | Undeclared events do not change the snapshot             |
| 3   | reachableStatesSubsetDeclared     | Every reachable state belongs to `def.states`            |
| 4   | replayEqualsFold                  | `replay(init, log)` equals `events.reduce(step)`         |
| 5   | guardsFalseNoTransition           | When all guards fail, the state is unchanged              |
| 6   | assignDoesNotMutate               | `assign` never modifies the previous context             |

---

## Comparison

|                            | aifsmjs        | XState v5         | Robot3            | @xstate/store     | Zag.js            |
| -------------------------- | -------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| Core size (gzip)           | ~2.8KB         | ~15KB             | ~1KB              | < 1KB             | per-component     |
| Hierarchical states         | Sugar (0.3.0)  | Yes               | No                | N/A               | Yes               |
| Async invoke / actor        | No             | Yes               | No                | N/A               | No                |
| Guard combinators           | and/or/not     | and/or/not        | No                | N/A               | No                |
| Effects dual-track          | enqueue        | enqueueActions    | reduce/action     | enq.effect()      | array of names    |
| Inspect / observe           | read-only      | inspect API       | No                | proposed          | watch ctx         |
| Serializable definition     | Yes            | Yes               | Partial           | Partial           | Yes               |
| fast-check adapter          | built-in       | No                | No                | No                | No                |
| Tree-shake subpath imports  | Yes            | Partial           | Yes               | Yes               | Yes               |

---

## Roadmap

| Version | Scope                                                              |
| ------- | ------------------------------------------------------------------ |
| v0.1    | core + guards + effects + inspect + replay + pbt (this release)    |
| v0.2    | Async-guard detection, coverage tuning, llms-full.txt verify gate  |
| v0.3    | Hierarchical sugar via `state.sub` (experimental)                  |
| v0.4    | Sub-machine API promoted to stable; dependency-reduction cycle     |
| v0.5    | `aifsmjs-bridge-bitecs` / `aifsmjs-bridge-pixi` (separate sub-packages) |
| v1.0    | API freeze and stability guarantee                                  |

**Out of scope (v1)**:

- **Parallel state regions** (out of scope for v1)
- **Actor invocation / spawn** (out of scope for v1)
- **Tick / game-loop hook** (out of scope for v1)
- **ECS / Pixi bridges** (out of scope for v1)

**Future candidate**: `historyState` — remember last active sub-state on
re-entry. Workaround today: snapshot via `onTransition` and restore
manually.

---

## License

[MIT](LICENSE)
