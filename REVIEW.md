# aifsmjs Review

Current review state after the 2026-09-28 ai*js pass.

## Current Known Issues / Backlog

| Priority | Area | Status | Notes |
| --- | --- | --- | --- |
| P1 | `send()` effect/notify ordering (aifsmjs-3) | Open | A synchronous effect handler that calls `send()` (the README-recommended pattern) commits and notifies the inner transition before the outer one, so subscribers see a stale value and `'transition'` events arrive reversed. Fix: run-to-completion mailbox for re-entrant `send()`/`reset()`. |
| P2 | Middleware freezes caller-owned events (aifsmjs-4) | Open | `runMiddleware` deep-freezes the caller's event object (and its payload graph) whenever middleware is configured, in every `NODE_ENV`, breaking the never-mutates-inputs contract. Fix: freeze a wrapper around `{prev,next,event,...}` instead of the event itself, or deep-freeze only a dev-only copy. |
| P2 | `reset()` changed-detection ignores context (aifsmjs-7) | Open | `reset()` computes `changed` from `value` alone, so resetting to the same value with a different context skips subscribers/middleware/`'transition'` silently. Fix: also compare `context`/`status` when computing `changed`. |
| P2 | Re-entrant `send()` during sub lifecycle (aifsmjs-10) | Open | No re-entrancy guard between `step()` and commit lets a child's `abort`/`dispose` listener call `send()` mid-transition, leaking a live child into a state with no `sub`. Fix: a `stepping` guard that queues or rejects nested `send()`/`reset()`. |
| P2 | `mergeContext` replaces non-plain/falsy contexts (aifsmjs-11) | Open | A class-instance context is replaced wholesale by a `Partial<Ctx>` action patch (losing other fields/prototype), and a falsy non-nullish patch (`false`, `0`) replaces a plain context outright. Fix: prototype-preserving merge for object contexts; reject non-object patches. |
| P3 | Sub-runtime stale handle after init failure (aifsmjs-8) | Open | Rolling back a failed sub-machine init disposes the old child before the new one exists, so `subRuntime()` stays `undefined` (handle already disposed) until the state is re-entered. Fix: create the new child before disposing the old one. `apiChange: true` (reorders child create/dispose), so out of P3 scope. |
| P3 | Same-value guard re-evaluated twice (aifsmjs-9) | Open | `send()` re-runs guard resolution via `findChosenIsExternal()` to decide internal-vs-external for a same-value transition, so a non-idempotent guard can pick a different candidate than `step()` did and desync the sub-machine lifecycle. Fix: return externality from a shared internal step instead of a second guard pass. `apiChange: true`, out of P3 scope. |
| P3 | Sub cycle through initial states (aifsmjs-15) | Open | The definition-time cycle guard stops `validateDefinition` from looping forever on a self/mutually-referential `sub`, but does not reject a cycle that runs through *initial* states, so `createRuntime` recurses until the stack overflows. Fix: follow the `initial`-state sub chain with a path set at validation time and reject a revisit. Deferred: a real structural change to `validateDefinition`, and `dist/pbt/index.js` has no size-budget headroom left this pass (see below). |
| P3 | `after()` ms clamping (aifsmjs-17) | Open | `after()` passes `ms` straight to `setTimeout`; delays above 2^31-1, `Infinity`, or `NaN` are silently clamped to ~1ms by the host, so a long-lived or "never" timer fires immediately. Fix: validate `ms` and chain successive timeouts past the 2^31-1 boundary. Deferred: reworking cancel/abort semantics across a timer chain is a larger change than a P3 patch. |
| P3 | Async effect rejection with no `'error'` listener is swallowed (aifsmjs-14) | Open | With no `rt.on('error')` registered (or after `dispose()` cleared listeners), a rejecting async effect disappears without trace. Surfacing it as `unhandledRejection` would crash Node >=15 processes by default and changes the STABILITY "fire-and-forget, rejections go to `'error'`" contract, so it needs a decision first (e.g. an opt-in handler or a dev-only warning). |
| P3 | PBT property runtimes never disposed (aifsmjs-16, partial) | Open | The effect-dispatch half of aifsmjs-16 is fixed (see below); disposing each property's runtime (so its abort signal fires) was left out — adding `try/finally { real.dispose() }` to all three properties pushed `dist/pbt/index.js` over its 8,500 B budget. |
| — | `dist/pbt/index.js` size budget is nearly full | Note | 8,471 / 8,500 B after this pass. Any further change to the shared `runtime.ts`/`definition.ts`/`snapshot.ts`/`lifecycle.ts` closure will need a compensating trim or a budget review. |

## Fixed Summary

- Async guards are rejected at definition/runtime boundaries.
- Reset snapshot integrity and immutable snapshot behavior are covered.
- Scheduler abort listeners are cleaned up after cancel/fire.
- Sub-machine child abort/dispose listener leaks were fixed.
- Object.prototype keys (`toString`, `constructor`, ...) are no longer treated as declared transitions/guards/actions/effects; only own keys resolve (aifsmjs-1).
- `deepFreeze` no longer throws on binary data (`ArrayBuffer` views) in context or event payloads, in dev or via middleware in production (aifsmjs-2).
- `deepFreeze` recurses through already shallow-frozen objects (e.g. effect descriptors), so middleware can no longer mutate an effect payload before dispatch, and an already-frozen dev context is still deep-frozen (aifsmjs-5).
- Runtime event listeners are isolated per-listener: a throwing `'dispose'`/`'error'` listener no longer prevents later listeners for the same event from running (aifsmjs-6).
- `assignDoesNotMutate` detects mutation by structural fingerprint instead of `structuredClone`, so it no longer false-fails on class-instance or callback-bearing context (aifsmjs-12).
- `setup().defineMachine()` infers `States` from `keyof states` only, so a terminal state written as `{}` or `{ final: true }` no longer collapses the inferred union (aifsmjs-13).
- PBT's `snapshotAlwaysFrozen`/`reachableStatesSubsetDeclared`/`replayEqualsFold` runtimes no longer dispatch real effects during generated command runs (aifsmjs-16; disposing those runtimes was scoped out — see below).
- `createScheduler().after()` merges `signal`/`setTimeout`/`clearTimeout` field-by-field with `??`, so an explicitly-undefined per-call option no longer silently drops the scheduler's default (aifsmjs-18).
- `MachineConfig` is re-exported from the root barrel, and the README/README_ZHTW `aifsmjs/effects` row now names the real export (`createEnqueuer()`, not `enqueue.effect()`) (aifsmjs-21).
- An explicit `context: undefined` in `defineMachine`/`setup().defineMachine` now defaults to `{}` like an absent key (aifsmjs-19).
- `IS_DEV` reads `process.env.NODE_ENV` directly (inside try/catch), so bundler define-replacement in Vite/webpack 5 browser builds enables dev-mode deep-freezing (aifsmjs-20).
- `scripts/check-size.mjs` no longer claims a README "Size budget" bullet mirrors its caps; README carries no such content (aifsmjs-22).

## Verification Baseline

- `pnpm typecheck`
- `pnpm test`
- `pnpm verify:docs`
- `pnpm verify:exports`
- `pnpm verify:dist`
- `pnpm verify:llms`
- `pnpm check:size`
