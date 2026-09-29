# aifsmjs Review

Current review state after the 2026-09-29 ai*js 0.6.0 pass.

## Current Known Issues / Backlog

| Priority | Area | Status | Notes |
| --- | --- | --- | --- |
| P3 | Listener removed and re-added in one round | Deferred | Listener sets hold functions, so a listener that is removed and then registered again with the same function during one notification round still fires in that round, where the ai*js fan-out rule treats the re-registration as a new entry that waits for the next event. Deferred: per-registration entries would change the existing dedupe contract (registering the same function twice), which is its own breaking change. |
| P3 | Argument validation outside the definition/runtime boundary | Deferred | `step`, `replay`, `evalGuard`, `mergeContext`, the guard combinators, `runEffects`, the inspect middleware factories, the PBT properties and the shape of `on()`'s `signal` option trust their typed arguments, so misuse there can still surface as a bare `TypeError`. Deferred: an error class in the guards/inspect/replay closures and checks on the hot `step()` path cost bytes and time for callers that already pass typed values; STABILITY.md documents the boundary. |
| — | Post-commit synchronous throws | Documented | A middleware, synchronous effect-handler or subscriber throw happens after commit: the snapshot stays committed, later notifications for that event are skipped and queued `send()`/`reset()` calls are dropped (README Sharp Edges, STABILITY.md). An opt-in safer mode is not planned for 0.6.x. |
| — | Effect payloads are deep-frozen when middleware is configured | Documented | Kept from aifsmjs-5 so middleware cannot alter a payload before dispatch; an object passed as an effect payload is frozen with it (README Sharp Edges). The caller's event is never frozen. |
| — | Size headroom | Note | 6,654 / 6,700 B (`dist/index.js`) and 8,718 / 8,800 B (`dist/pbt/index.js`) after this pass; budgets were raised for 0.6.0 with an itemised comment in `scripts/check-size.mjs`. |

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
- PBT's `snapshotAlwaysFrozen`/`reachableStatesSubsetDeclared`/`replayEqualsFold` runtimes no longer dispatch real effects during generated command runs (aifsmjs-16, first half).
- `createScheduler().after()` merges `signal`/`setTimeout`/`clearTimeout` field-by-field with `??`, so an explicitly-undefined per-call option no longer silently drops the scheduler's default (aifsmjs-18).
- `MachineConfig` is re-exported from the root barrel, and the README/README_ZHTW `aifsmjs/effects` row now names the real export (`createEnqueuer()`, not `enqueue.effect()`) (aifsmjs-21).
- An explicit `context: undefined` in `defineMachine`/`setup().defineMachine` now defaults to `{}` like an absent key (aifsmjs-19).
- `IS_DEV` reads `process.env.NODE_ENV` directly (inside try/catch), so bundler define-replacement in Vite/webpack 5 browser builds enables dev-mode deep-freezing (aifsmjs-20).
- `scripts/check-size.mjs` no longer claims a README "Size budget" bullet mirrors its caps; README carries no such content (aifsmjs-22).
- 0.6.0: `send()`/`reset()` are run-to-completion with a FIFO mailbox, so an effect handler's or listener's `send()` is notified after the outer event, and a child listener's call into the parent can no longer run mid-transition (aifsmjs-3, aifsmjs-10).
- 0.6.0: middleware passes the caller's event unfrozen in every `NODE_ENV` (aifsmjs-4).
- 0.6.0: `reset()` notifies when the status or context reference changes, not only the value (aifsmjs-7).
- 0.6.0: sub-machine replacement is prepare-then-commit; an init failure leaves the old child live, and a parent disposed mid-swap no longer adopts the new child (aifsmjs-8).
- 0.6.0: `send()` reuses `step()`'s guard pass (internal `stepWithMeta`) to decide the sub lifecycle; guards run once per event (aifsmjs-9).
- 0.6.0: `mergeContext` keeps an object context's prototype and rejects primitive patches with `InvalidActionResultError` (aifsmjs-11).
- 0.6.0: an async effect rejection with no `'error'` listener is reported by a dev-only `console.warn` (aifsmjs-14).
- 0.6.0: `defineMachine` rejects a sub-machine cycle through initial states (aifsmjs-15).
- 0.6.0: the PBT properties dispose every generated run's runtime (aifsmjs-16, second half).
- 0.6.0: `after()` validates `ms`/`fn` and clamps delays above 2^31-1 ms (aifsmjs-17).
- 0.6.0 family rules: listeners removed mid-dispatch are skipped; argument misuse at the definition/runtime boundary throws `InvalidDefinitionError`; `package.json` `exports` nest `types` under `import`/`require` with `.d.cts` types, checked by the recursive `verify-exports`.
- 0.6.0 size: tsup's shared `__export` chunk (paid by every entry), the unreachable child parent-abort wiring and duplicated transition-pick/plain-object helpers were removed.

## Verification Baseline

- `pnpm typecheck`
- `pnpm test`
- `pnpm verify:docs`
- `pnpm verify:exports`
- `pnpm verify:dist`
- `pnpm verify:llms`
- `pnpm check:size`
