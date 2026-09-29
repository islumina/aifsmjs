# Changelog

All notable changes to aifsmjs are summarized here.

## [0.6.0] - 2026-09-29

### Breaking

- `Runtime.send()` / `Runtime.reset()`: a call made while the runtime is already processing an event (from middleware, an effect handler, a `subscribe` or `'transition'` listener, or a child runtime's listener) is now queued and processed after the current event's last notification (run-to-completion) instead of running inside it, because the README-recommended "send from an effect" pattern delivered notifications in reverse and left subscribers holding a stale snapshot; the nested call returns the snapshot committed at that moment, and an error from a queued event propagates from the outermost call. Migration: read `getSnapshot()` after the outer `send()`/`reset()` returns (or subscribe) instead of using a nested call's return value or reading the snapshot right after it, and catch errors around the outermost call rather than around a nested `send()`.
- `Runtime.subscribe()` / `Runtime.on()` / `Runtime.onTransition()`: a listener removed while a notification is running (by its unsubscribe function, `once`, its `signal`, or `dispose()`) is now skipped for the rest of that round instead of still receiving the in-flight event, per the ai*js fan-out re-entrancy rule. Migration: if a removed listener must still see the current event, remove it after the call returns (for example `queueMicrotask(off)`), and do not rely on the remaining listeners running after a mid-notification `dispose()`.
- `mergeContext()` / action results: for an object context (not an array or binary view) a plain-object patch is now merged into a copy that keeps the context's prototype, where a class-instance context used to be replaced by the bare patch and lose its other fields and methods, and a non-nullish primitive result such as `false` or `0` now throws `InvalidActionResultError` from `step()`/`send()` instead of replacing the context. Migration: return a plain-object partial (or `undefined`) from actions on object contexts; to replace the context wholesale, return a new instance or array (non-plain objects still replace it).
- `Runtime.send()` / `Runtime.reset()` sub-machine lifecycle: when a transition replaces a child, the new child is now constructed before the old child is disposed, so an init failure leaves the old child live and still returned by `subRuntime()` (it used to be disposed first, leaving `undefined`). Migration: code that runs while a new child is being created must not assume the previous sibling child is already disposed, and code that expected `subRuntime()` to be `undefined` after a `SubMachineError` with `phase: "init"` should expect the previous child.
- `after()` / `createScheduler().after()`: an `ms` that is `NaN`, `±Infinity`, negative or not a number now throws `RangeError`, and a non-function `fn` throws `TypeError`, synchronously and before any timer is set (they used to fire after about 1 ms, or throw later from inside the timer), and a finite delay above 2^31-1 ms is clamped to 2^31-1 instead of firing almost at once. Migration: pass a finite `ms >= 0` and a function; callers using `Infinity` to mean "never" should simply not schedule.
- `defineMachine()` / `setup().defineMachine()` / `createMachine()` / `createRuntime()` / `Runtime.send()` / `Runtime.reset()` / `Runtime.subscribe()` / `Runtime.on()` / `Runtime.onTransition()`: argument misuse now throws `InvalidDefinitionError` (`aifsmjs: <subject> must be <constraint>`) at the call — a non-object definition, `states`, state or transition entry; a non-object `impl` or options object, or a `middleware` option that is not an array of functions; an event that is not an object with a string `type`; a non-function listener or an unknown `on()` event type — instead of a bare `TypeError` (at the call or at a later `send()`), a listener that threw at every notification, or a silently accepted value. Migration: pass `{}` as `impl` when a machine uses no named implementations, pass object events with a string `type` and function listeners, and catch `InvalidDefinitionError` where you caught `TypeError`.

### Changes

- Added: `InvalidActionResultError` (root export, `name === "InvalidActionResultError"`, with the offending `actionName`) for an action that returns a non-nullish primitive for an object context.
- Added: `mergeContext(current, patch, actionName?)` takes an optional action name for that error (default `"<inline>"`).
- Changed: `InvalidDefinitionError` is also the argument-validation error of the definition/runtime boundary; its non-object `states` message now reads `aifsmjs: definition states must be an object`.
- Changed: an async effect rejection with no `'error'` listener (none registered, or cleared by `dispose()`) is still discarded, but is now reported via `console.warn` when `NODE_ENV !== "production"`; production behaviour is unchanged and it never becomes an unhandled rejection.
- Changed: `aifsmjs/pbt`'s `properties` is a frozen object carrying the same eight functions instead of a module namespace object, which drops tsup's shared `__export` helper chunk (about 210 B gzip) from every subpath entry.
- Changed: `step()` returns a shared frozen empty `effects` array when nothing fires.
- Changed: size budgets in `scripts/check-size.mjs` (maintainer-approved for 0.6.0): `dist/index.js` 6,500 -> 6,700 B and `dist/pbt/index.js` 8,500 -> 8,800 B, other budgets unchanged; measured gzip closures 0.5.9 -> 0.6.0: index 6,359 -> 6,654, guards 1,375 -> 1,161, effects 1,574 -> 1,365, inspect 552 -> 329, replay 3,115 -> 3,139, pbt 8,471 -> 8,718, timer 1,071 -> 1,018 B.
- Fixed: transition/implementation lookups (`state.on[event.type]`, guard/action/effect refs) now resolve by own key only, so an undeclared event type or ref named after an `Object.prototype` member (`toString`, `constructor`, `__proto__`, ...) is no longer treated as a declared transition.
- Fixed: `deepFreeze` no longer throws on binary data (`ArrayBuffer` views, e.g. `Uint8Array`) reached through context or event payloads, in dev snapshots or via middleware in production.
- Fixed: `deepFreeze` recurses through an object that is already shallow-frozen (e.g. an effect descriptor), instead of stopping there — middleware can no longer mutate an effect payload before dispatch, and an already shallow-frozen dev context is still deep-frozen.
- Fixed: runtime event listeners are isolated per-listener — a throwing `'dispose'` or `'error'` listener no longer prevents later listeners for the same event from running.
- Fixed: `assignDoesNotMutate` detects mutation by a structural fingerprint instead of `structuredClone`, so it no longer false-fails for a pure machine whose context holds a class instance or a callback.
- Fixed: `setup().defineMachine()` infers `States` from `keyof states` only, so a terminal state written as `{}` or `{ final: true }` no longer collapses the inferred state union.
- Fixed: an explicit `context: undefined` passed to `defineMachine` / `setup().defineMachine` now defaults to `{}`, the same as an absent `context` key.
- Fixed: dev-mode detection reads `process.env.NODE_ENV` directly, so Vite / webpack 5 define-replacement enables dev-only deep-freezing in browser builds that have no `process` global.
- Fixed: the PBT `snapshotAlwaysFrozen` and `reachableStatesSubsetDeclared` properties no longer dispatch real effects while driving generated commands through a runtime.
- Fixed: `createScheduler().after()` merges `signal`/`setTimeout`/`clearTimeout` field-by-field with `??` instead of an object spread, so an explicitly-undefined per-call option no longer silently overrides the scheduler's default.
- Fixed: `MachineConfig`, the parameter type of `defineMachine`, is re-exported from the package root.
- Fixed: `reset()` now notifies subscribers, middleware (`changed: true`) and `'transition'` listeners when the context reference (or status) differs from the initial snapshot; it used to compare the state value alone and stay silent.
- Fixed: middleware no longer deep-freezes the caller's event object (and its payload graph) in any `NODE_ENV`; `MiddlewareContext.event` is the caller's object, passed unfrozen.
- Fixed: a parent `send()`/`reset()` issued from a child's `'dispose'` listener during a transition is queued until the transition commits, so a live child can no longer be left in a state that has no `sub`.
- Fixed: a parent disposed by a child's `'dispose'` listener during a transition no longer adopts the replacement child; the replacement is disposed and `subRuntime()` returns `undefined`.
- Fixed: `send()` decides whether a same-value transition is external from the guard pass that produced the snapshot, so each guard runs once per event and a non-idempotent guard can no longer desync the sub-machine lifecycle from the committed state.
- Fixed: `defineMachine()` rejects a sub-machine cycle through initial states with `InvalidDefinitionError` instead of letting `createRuntime()` recurse until the stack overflows; self-references through non-initial states stay legal.
- Fixed: `snapshotAlwaysFrozen`, `reachableStatesSubsetDeclared` and `replayEqualsFold` dispose the runtime they create for each generated run, so its `AbortSignal` fires and no run leaks a live runtime.
- Fixed: `package.json` `exports` nests `types` under `import` and `require` (`require.types` points at the `.d.cts` files) for every subpath, so `node16` / `nodenext` CommonJS consumers no longer hit TS1479 / TS1471; `verify-exports` walks nested conditions.
- Docs: corrected the `aifsmjs/effects` Public Surface row (README/README_ZHTW) to name the real export, `createEnqueuer()`, instead of `enqueue.effect()`.
- Docs: STABILITY.md's Behavioral Contract states the run-to-completion and fan-out clauses, the reset, merge, argument-validation and timer rules, and the new sub-machine order; README and README_ZHTW Lifecycle Rules and Sharp Edges mirror them, and the `Runtime` / `MiddlewareContext` JSDoc says the same.

## [0.5.9] - 2026-06-29

- Fixed: `dispose()` never throws and always completes teardown even if a `'dispose'` event listener throws (external-signal abort cleanups no longer leak); restores the never-throws / idempotency contract.
- Fixed: sub-machine definitions are now deep-validated at construction — an unknown transition target or a declared-async guard inside a `sub` is rejected by `defineMachine` (with a cycle guard) instead of surfacing only at `child.send()`.
- Fixed: PBT replay/assign oracles use structural deep-equality (`node:util` `isDeepStrictEqual`) instead of `JSON.stringify`, which mis-handled key order, `undefined` keys, `Map`/`Set`/`Date`, and `BigInt`.
- Docs: clarified that `replay()` reproduces parent value+context only (sub-machine state is not modelled) and that production snapshots are frozen at the top level only.

## [0.5.8] - 2026-06-14

- Documentation-only slimming pass across README, stability notes, review backlog, and LLM context. Family version alignment at 0.5.8 — no runtime or API change. `setup().defineMachine()` inference tests and an opt-in safer mode for post-commit synchronous throws remain documented follow-ups.

## [0.5.6] - 2026-06-10

- Hardened async guard rejection, reset snapshot integrity, sub-machine lifecycle cleanup, and scheduler abort cleanup.
- Clarified fire-and-forget effect semantics and post-commit ordering.
- Regenerated generated LLM context from canonical docs.

## Older releases

- `0.5.5` through `0.5.1` focused on release hygiene, docs accuracy, property tests, and lifecycle regressions.
- `0.4.x` stabilized sub-machine lifecycle semantics.
- `0.3.x` added inspect/replay/PBT/timer helpers and dependency reduction.
- `0.2.x` hardened definitions, guard/action resolution, and examples.
- `0.1.x` introduced `defineMachine`, `createRuntime`, `step`, `assign`, snapshots, and core error classes.
