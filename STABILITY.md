# Stability

## Stable Surface

| Surface | Status | Notes |
| --- | --- | --- |
| `aifsmjs` root | Stable | Definition/runtime/step/snapshot APIs and core errors. |
| `aifsmjs/guards` | Stable | Sync guard combinators. |
| `aifsmjs/effects` | Stable | Effect descriptors and dispatcher helper. |
| `aifsmjs/inspect` | Stable | Read-only middleware helpers. |
| `aifsmjs/replay` | Stable | Pure log replay. |
| `aifsmjs/pbt` | Stable | fast-check helpers. |
| `aifsmjs/timer` | Stable | Timer/scheduler helpers. |

## Behavioral Contract

- Definition data is serializable when using string refs instead of inline functions.
- `step()` is pure and never dispatches effects.
- Runtime commit happens before middleware, effect dispatch, and listener notification.
- Async effects are fire-and-forget; rejections emit runtime `"error"`.
- `reset()` does not run entry actions.
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
- Init failure rolls back parent transition.
- Dispose failure happens after the old child is already torn down and surfaces as `SubMachineError`.
- External child disposal leaves a stale handle until the parent leaves/re-enters the state.

## Drafts

Parallel regions, actor spawning, async guards, and awaited effect completion are not implemented.
