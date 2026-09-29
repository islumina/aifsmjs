# Stability

## Stable Surface

| Surface | Status | Notes |
| --- | --- | --- |
| `aifsmjs` root | Stable | Definition/runtime/step/snapshot APIs and core errors: `InvalidDefinitionError`, `InvalidActionResultError`, `UnknownActionError`, `UnknownGuardError`, `AsyncGuardError`, `RuntimeDisposedError`, `SubMachineError`. |
| `aifsmjs/guards` | Stable | Sync guard combinators. |
| `aifsmjs/effects` | Stable | Effect descriptors and dispatcher helper. |
| `aifsmjs/inspect` | Stable | Read-only middleware helpers. |
| `aifsmjs/replay` | Stable | Pure log replay. |
| `aifsmjs/pbt` | Stable | fast-check helpers. |
| `aifsmjs/timer` | Stable | Timer/scheduler helpers. Exports no error class: misuse throws a built-in `RangeError`/`TypeError` whose message starts with `aifsmjs: `. |

## Behavioral Contract

- Definition data is serializable when using string refs instead of inline functions.
- `step()` is pure and never dispatches effects. Each guard on the path to the chosen transition runs at most once per event, and `send()` decides the sub-machine lifecycle from that same guard pass.
- `send()`/`reset()` are run-to-completion: for one event, commit -> middleware -> effects -> `subscribe` listeners -> `'transition'` listeners all complete before any event sent from inside them is processed; nested `send()`/`reset()` calls are queued FIFO and processed afterwards with the same full sequence; a nested call returns the snapshot committed at the time of the call, not the outcome of its own event — read `getSnapshot()` after the outermost call returns.
- A throw from any event in that sequence (a `SubMachineError`, an unknown action or guard, an `InvalidActionResultError`, or a synchronous middleware, effect-handler or listener throw) drops the calls still queued and propagates from the outermost `send()`/`reset()`; the snapshot stays at the last successful commit. `dispose()` is never queued: it runs at once, drops queued calls, and the outer call returns the last committed snapshot without throwing (the event in progress finishes with cleared listeners and an aborted signal). Parent and child runtimes queue independently.
- Listener fan-out (`subscribe`, `on`, `onTransition`) is synchronous over a copy of the listener set taken when the notification starts: a listener added meanwhile first fires on the next event, and one removed meanwhile (its unsubscribe function, `once`, its `signal`, or `dispose()`) is skipped for the rest of that round. A `once` listener is removed before it is called. A throwing `on()` listener does not stop the others; the first error is rethrown once all have run.
- Middleware receives the caller's event object by reference and never freezes it (treat it as read-only). The middleware context object is frozen, `prev`/`next` are frozen to the depth below, and the effect descriptors are deep-frozen, payloads included.
- Async effects are fire-and-forget; rejections emit runtime `"error"`. A rejection with no `'error'` listener is discarded in production and reported via `console.warn` when `NODE_ENV !== "production"`; it never becomes an unhandled rejection.
- `reset()` does not run entry actions and always replaces the current sub-machine child. `reset()` notifies subscribers, middleware (`changed: true`) and `'transition'` listeners whenever the value, status, or context reference differs from the initial snapshot.
- An action result is merged into an object context (not an array or binary view) by a shallow copy that keeps the context's prototype; only own enumerable string and symbol properties are carried, not `#private` or non-enumerable members, so prefer plain-object contexts. A non-nullish primitive result (`false`, `0`, `""`, ...) for an object context throws `InvalidActionResultError`; any other non-plain-object result (an array, a class instance) replaces the context, as does any result for a primitive or array context.
- Argument misuse at the definition/runtime boundary (`defineMachine`, `setup().defineMachine`, `createMachine`, `createRuntime`, `send`, `reset`, `subscribe`, `on`, `onTransition`) throws `InvalidDefinitionError` (`aifsmjs: <subject> must be <constraint>`) before anything is created or registered. Pure helpers (`step`, `replay`, `mergeContext`, guard combinators, `runEffects`, inspect middleware, PBT properties) trust their typed arguments.
- `after()` / `createScheduler().after()`: `ms` must be a finite number >= 0 (`RangeError`) and `fn` a function (`TypeError`), checked before any timer or listener exists; a finite delay above 2^31-1 ms (about 24.8 days) is clamped to 2^31-1 when handed to `setTimeout`.
- `dispose()` aborts runtime signal, clears listeners, and is idempotent. A throwing `'dispose'` listener is swallowed and never aborts teardown.

## Replay caveat

`replay()` and `step()` reproduce only the **parent** machine's `value` + `context` (`aifsmjs/replay`, "Pure event-log replay" in the README). Sub-machine state is **not** modelled: the pure lifecycle has no `sub` references, so a replayed/stepped snapshot reflects the parent state alone and never re-instantiates, advances, or restores any child runtime. To capture child state for time-travel or incident reproduction, snapshot the child separately from the live runtime via `subRuntime()`.

## Snapshot freezing depth

Snapshot freezing is depth-dependent on `NODE_ENV`:

- **Dev** (`NODE_ENV !== "production"`): the whole snapshot tree is deep-frozen, so accidental nested mutation throws immediately.
- **Production** (`NODE_ENV === "production"`): only the **top-level** snapshot object is frozen (`Object.freeze`). Nested `context` is **caller-owned and not deeply frozen** — treat it as read-only by convention; the library does not enforce immutability of nested context in prod.

## Sub-machines

Sub-machines are stable but sharp:

- Entry lazily creates the child; exit disposes it.
- Entry constructs the new child before the old child is disposed; init failure leaves the old child live and the parent unchanged; dispose failure surfaces after the old child is torn down and the new child is discarded.
- A `send()`/`reset()` on the parent from a child's listener during the parent's transition is queued until that transition has committed.
- Sub definitions may reference themselves or each other only through non-initial states; `defineMachine` rejects a cycle through initial-state subs, which the runtime would otherwise boot without end.
- External child disposal leaves a stale handle until the parent leaves/re-enters the state.

## Drafts

Parallel regions, actor spawning, async guards, and awaited effect completion are not implemented.
