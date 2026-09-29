# aifsmjs

Small deterministic FSM library for replayable TypeScript/JavaScript state machines. Definitions are plain data; guards/actions/effects are injected at runtime.

> **Status: 0.6.0 - stable 1.0-track core.** Core FSM, guards, effects, inspect, replay, PBT helpers, scheduler, and sub-machines are live.

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
| `aifsmjs/effects` | `createEnqueuer()` and `runEffects()`. |
| `aifsmjs/inspect` | Read-only middleware helpers: `logger`, `persist`, `recorder`. |
| `aifsmjs/replay` | Pure event-log replay. |
| `aifsmjs/pbt` | fast-check property helpers. |
| `aifsmjs/timer` | `after()` and `createScheduler()`. |

## Lifecycle Rules

- `step(def, snapshot, event, impl)` is pure and returns `{ snapshot, effects, changed }`.
- `createRuntime()` owns mutable runtime state. Per event it commits, then runs middleware, effects, `subscribe` listeners and `'transition'` listeners, in that order.
- `send()`/`reset()` are run-to-completion: a call made from middleware, an effect handler or a listener is queued and runs after the current event's notifications, with the same full sequence.
- Guards and reducers are sync. Thenable guards throw `AsyncGuardError`.
- Effects are fire-and-forget descriptors. Async rejection is routed to the runtime `"error"` channel; with no `"error"` listener it is dropped (with a `console.warn` outside production).
- `reset()` rewinds to the initial snapshot without running entry actions, and notifies listeners whenever the value, status or context reference changes.
- `dispose()` is idempotent; post-dispose `send()`/`reset()` throw `RuntimeDisposedError`.
- Misused arguments to `defineMachine`, `createRuntime` and the runtime methods throw `InvalidDefinitionError`.

## Sharp Edges

- Middleware, synchronous effect and subscriber throws happen after snapshot commit. A throw can leave the committed snapshot visible without later notification, and it drops any queued `send()`/`reset()` calls.
- A nested `send()` returns the snapshot committed at the time of the call, not the outcome of its own event. Read `getSnapshot()` after the outermost call returns, or subscribe.
- A listener removed while a notification is running (unsubscribe, `once`, `signal`, `dispose()`) is skipped for the rest of that round.
- Middleware never freezes your event, but it deep-freezes effect descriptors, including any object you passed as a payload.
- Actions on an object context must return a plain-object patch (or nothing); the merge keeps the context's prototype. Returning `false`, `0` or `""` throws `InvalidActionResultError`. Prefer plain-object contexts.
- Sub-machine replacement builds the new child first: on init failure the old child stays live; on dispose failure the old child is already torn down and the new one is discarded.
- `subRuntime()` can return a disposed child handle if external code disposed it; it is recreated only after the parent exits and re-enters the sub state.
- `setup().defineMachine()` uses `NoInfer` so states infer from `keyof states`; keep regression tests for exact optional property configurations.
- `after()` throws `RangeError` for `NaN`, `Infinity` or a negative delay, and clamps delays above 2^31-1 ms (about 24.8 days). To mean "never", do not schedule.
- Do not perform async I/O inside guards or actions. Send events from effects instead.

## AI Context

- Short index: [`llms.txt`](llms.txt)
- Full generated context: [`llms-full.txt`](llms-full.txt)
- Stability contract: [`STABILITY.md`](STABILITY.md)
- Current review backlog: [`REVIEW.md`](REVIEW.md)
- Release history: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT
