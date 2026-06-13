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
- `dispose()` aborts runtime signal, clears listeners, and is idempotent.

## Sub-machines

Sub-machines are stable but sharp:

- Entry lazily creates the child; exit disposes it.
- Init failure rolls back parent transition.
- Dispose failure happens after the old child is already torn down and surfaces as `SubMachineError`.
- External child disposal leaves a stale handle until the parent leaves/re-enters the state.

## Drafts

Parallel regions, actor spawning, async guards, and awaited effect completion are not implemented.
