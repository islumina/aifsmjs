# aifsmjs

Small deterministic FSM library for replayable TypeScript/JavaScript state machines. Definitions are plain data; guards/actions/effects are injected at runtime.

> **Status: 0.5.6 - stable 1.0-track core.** Core FSM, guards, effects, inspect, replay, PBT helpers, scheduler, and sub-machines are live.

## Install

```bash
pnpm add aifsmjs
```

```ts
import { assign, createRuntime, setup } from "aifsmjs";
```

## Quick Start

```ts
type Ctx = { ticks: number };
type Evt = { type: "NEXT" };

const trafficLight = setup<Ctx, Evt>().defineMachine({
  id: "trafficLight",
  initial: "red",
  context: { ticks: 0 },
  states: {
    red: { on: { NEXT: { target: "green", actions: ["bump"] } } },
    green: { on: { NEXT: { target: "yellow", actions: ["bump"] } } },
    yellow: { on: { NEXT: { target: "red", actions: ["bump"] } } },
  },
});

const runtime = createRuntime(trafficLight, {
  actions: {
    bump: assign(({ context }) => ({ ticks: context.ticks + 1 })),
  },
});

runtime.send({ type: "NEXT" });
console.log(runtime.getSnapshot().value); // "green"
```

Prefer `setup<Ctx, Evt>().defineMachine()` for state inference. Use bare `defineMachine<Ctx, Evt, States>()` only when you need explicit generic control.

## Public Surface

| Import | Purpose |
| --- | --- |
| `aifsmjs` | `setup`, `defineMachine`, `createRuntime`, `createMachine`, `step`, `assign`, snapshots, runtime/errors/types. |
| `aifsmjs/guards` | `and`, `or`, `not`, `stateIn`. Guards must be synchronous. |
| `aifsmjs/effects` | `enqueue.effect()` descriptors and `runEffects()`. |
| `aifsmjs/inspect` | Read-only middleware helpers: `logger`, `persist`, `recorder`. |
| `aifsmjs/replay` | Pure event-log replay. |
| `aifsmjs/pbt` | fast-check property helpers. |
| `aifsmjs/timer` | `after()` and `createScheduler()`. |

## Lifecycle Rules

- `step(def, snapshot, event, impl)` is pure and returns `{ snapshot, effects, changed }`.
- `createRuntime()` owns mutable runtime state, dispatches effects after commit, and emits transition/error/dispose events.
- Guards and reducers are sync. Thenable guards throw `AsyncGuardError`.
- Effects are fire-and-forget descriptors. Async rejection is routed to the runtime `"error"` channel.
- `reset()` rewinds the snapshot and notifies listeners, but does not run entry actions.
- `dispose()` is idempotent; post-dispose `send()`/`reset()` throw `RuntimeDisposedError`.

## Sharp Edges

- Middleware and synchronous effect throws happen after snapshot commit. A throw can leave the committed snapshot visible without later notification.
- Sub-machine replacement can roll back on init failure, but dispose failure has already torn down the old child.
- `subRuntime()` can return a disposed child handle if external code disposed it; it is recreated only after the parent exits and re-enters the sub state.
- `setup().defineMachine()` uses `NoInfer` so states infer from `keyof states`; keep regression tests for exact optional property configurations.
- Do not perform async I/O inside guards or actions. Send events from effects instead.

## AI Context

- Short index: [`llms.txt`](llms.txt)
- Full generated context: [`llms-full.txt`](llms-full.txt)
- Stability contract: [`STABILITY.md`](STABILITY.md)
- Current review backlog: [`REVIEW.md`](REVIEW.md)
- Release history: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT
