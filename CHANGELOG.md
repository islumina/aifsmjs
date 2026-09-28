# Changelog

All notable changes to aifsmjs are summarized here.

## [Unreleased]

- Fixed: transition/implementation lookups (`state.on[event.type]`, guard/action/effect refs) now resolve by own key only, so an undeclared event type or ref named after an `Object.prototype` member (`toString`, `constructor`, `__proto__`, ...) is no longer treated as a declared transition.
- Fixed: `deepFreeze` no longer throws on binary data (`ArrayBuffer` views, e.g. `Uint8Array`) reached through context or event payloads, in dev snapshots or via middleware in production.
- Fixed: `deepFreeze` recurses through an object that is already shallow-frozen (e.g. an effect descriptor), instead of stopping there — middleware can no longer mutate an effect payload before dispatch, and an already shallow-frozen dev context is still deep-frozen.
- Fixed: runtime event listeners are isolated per-listener — a throwing `'dispose'` or `'error'` listener no longer prevents later listeners for the same event from running.
- Fixed: `assignDoesNotMutate` detects mutation by a structural fingerprint instead of `structuredClone`, so it no longer false-fails for a pure machine whose context holds a class instance or a callback.
- Fixed: `setup().defineMachine()` infers `States` from `keyof states` only, so a terminal state written as `{}` or `{ final: true }` no longer collapses the inferred state union.
- Fixed: an async effect handler's rejection now surfaces as a normal `unhandledRejection` when no `'error'` listener can observe it (including after `dispose()` cleared the listeners), instead of disappearing silently.
- Fixed: the PBT `snapshotAlwaysFrozen` and `reachableStatesSubsetDeclared` properties no longer dispatch real effects while driving generated commands through a runtime.
- Fixed: `createScheduler().after()` merges `signal`/`setTimeout`/`clearTimeout` field-by-field with `??` instead of an object spread, so an explicitly-undefined per-call option no longer silently overrides the scheduler's default.
- Fixed: `MachineConfig`, the parameter type of `defineMachine`, is re-exported from the package root.
- Docs: corrected the `aifsmjs/effects` Public Surface row (README/README_ZHTW) to name the real export, `createEnqueuer()`, instead of `enqueue.effect()`.

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
