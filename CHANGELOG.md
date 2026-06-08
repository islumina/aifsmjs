# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.5] - 2026-06-08

### Changed

- Project home migrated to the [`islumina`](https://github.com/islumina) GitHub org; the package is now published from there via npm trusted publisher (OIDC + SLSA provenance). Family-wide version alignment at `0.5.5` — no runtime or API changes.

## [0.5.3] - 2026-06-05

### Added

- **String-shorthand transitions and optional `context` (both additive, non-breaking).** Transitions now accept a bare target string — `on: { EVENT: "target" }` is sugar for `{ target: "target" }`, normalized in the resolver and composable inside guard-fallthrough arrays; and `context` is now optional in `defineMachine` / `setup().defineMachine`, defaulting to `{}` (`Ctx` defaults to `Record<string, never>`). Existing object-form transitions and explicit-`context` definitions are unaffected. (`src/fsm/types.ts`, `src/fsm/resolver.ts`, `src/fsm/definition.ts`, `src/fsm/lifecycle.ts`, `src/fsm/runtime.ts`)

## [0.5.2] - 2026-06-05

### Docs

- Review-driven documentation fixes (`README.md`, `README_ZHTW.md`, `llms-full.txt`): clarity and accuracy from a cross-package code review. No runtime or API change; `dist` byte-identical to 0.5.1.

## [0.5.1] - 2026-06-02

### Fixed

- **Memory: `after()` and `createScheduler().after()` accumulated dead abort
  listeners on a reused `AbortSignal`.** `{ once: true }` only removes the
  listener when the signal fires — not when the timer fires normally or
  `cancel()` is called. Scheduling many timers on one long-lived signal
  therefore accumulated dead `"abort"` closures. The fix explicitly calls
  `signal.removeEventListener("abort", cancel)` inside the fire callback (so
  a fired timer detaches immediately) and at the end of `cancel()` (so a
  cancelled timer also detaches). Same class of leak as the [0.1.2] and
  [0.3.1] abort-listener fixes; the timer subpath was the remaining gap.
  Four regression tests added to `test/timer/scheduler.test.ts` covering
  both `after()` and `createScheduler().after()`, fire and cancel paths.
  (`src/timer/scheduler.ts`)

### Changed

- **`fast-check` peer dependency range extended to `^3.20.0 || ^4.0.0`.**
  The ai\*js family standard is fast-check v4.8; consumers who have already
  upgraded to v4 no longer need to suppress a peer warning. The devDependency
  is pinned to `^4.8.0` so CI runs against v4. Consumers who remain on v3
  are fully unaffected — the `||` range keeps v3 satisfied. The `aifsmjs/pbt`
  subpath is the only entry point that imports fast-check; the core and all
  other subpaths are tree-shake-free of it.

## [0.4.1] — 2026-05-29

### Changed

- **`STABILITY.md` is now repo-only** — removed from the npm `files`
  allowlist, aligning with the majority of the ai*js family (5 of 7
  packages already ship the stability contract repo-only). The file stays
  in the repository and remains visible on GitHub and the rendered npm
  package page; it is simply no longer bundled inside the published
  tarball. Packaging consistency patch: **no runtime API change, no
  signature change**; the built bundles (`dist/`) are byte-identical to
  0.4.0 (core gzip 4,387 B).

## [0.4.0] — 2026-05-29

### Changed

- **Sub-machine API promoted experimental → stable.** The hierarchical
  sub-machine surface shipped in 0.3.0 — `StateDef.sub`, `StateDef.subImpl`,
  `Runtime.subRuntime()`, `SubMachineError`, and the `SubMachineDef` type
  alias — is now stable. Signatures and runtime semantics, including the
  init-failure quarantine behaviour, are frozen for the 1.x line; the
  boundaries documented in `STABILITY.md` are intentional design trade-offs,
  not instability. **No signature changed from 0.3.x.**

### Dependency reduction

- Part of the ai*js v0.4.0 dependency-reduction cycle. `fast-check` remains
  an **optional** peer dependency isolated to the `aifsmjs/pbt` subpath. A
  fresh build confirms the core entry and the five non-pbt subpaths
  (`guards` / `effects` / `inspect` / `replay` / `timer`) are tree-shake-free
  of `fast-check` (only `dist/pbt/index.js` references it). `pnpm audit`
  reports zero advisories. No `devDependency` changes.

### Compatibility

This release adds **no runtime API** and changes **no signature**. The core
bundle is byte-identical to 0.3.1 (gzip 4,387 B); existing 0.3.x consumer
code is unaffected. The only substantive change is the documented stability
tier of the sub-machine API.

## [0.3.1] — 2026-05-29

### Fixed

- **Memory: `on(type, fn, { once: true, signal })` left the abort listener
  attached after the once-handler fired.** The `once` wrapper removed itself
  from the listener set but did not detach the `AbortSignal` listener or drop
  its entry from the internal cleanup set, so the closure lingered on the
  external signal until the signal aborted or `dispose()` ran. With a
  long-lived signal and repeated once+signal registration, dead listeners
  accumulated. `on()` now routes the once-wrapper, the abort handler, and the
  returned unsubscribe through a single `cleanup()` that always detaches the
  abort listener. `runtime.onTransition(fn, { once, signal })` inherits the
  fix (it delegates to `on`). Same class of leak as the [0.1.2] abort-listener
  fix; `once` + `signal` together was the remaining gap. Present since 0.1.2.

This release is **non-breaking**. No API surface change; `once`-only,
`signal`-only, and no-option callers are byte-for-byte unaffected at runtime.
Core gzip 4,393 B → 4,387 B (the shared `cleanup` closure deduplicates).

## [0.3.0] — 2026-05-29

### Added

- **Hierarchical / sub-machine sugar** (experimental). `StateDef` accepts
  two new optional fields: `sub` (a child `SubMachineDef`) and `subImpl`
  (the child's `Implementations`). When the runtime enters a state with
  `sub`, a child `Runtime` is lazily instantiated; when it exits, the child
  is disposed. Access via `runtime.subRuntime()`. See `STABILITY.md` for
  the experimental contract.
  - New error: `SubMachineError` (`{ parentState, phase, cause }`) thrown
    by `send()` / `reset()` on child init / dispose failure. `dispose()`
    cascade swallows child dispose exceptions (idempotent + never-throws
    contract).
  - New type alias: `SubMachineDef<SubCtx, SubEvt, SubStates>`.
- **`runtime.onTransition(handler, opts?)`** — semantic sugar over
  `runtime.on('transition', handler, opts)`. One-line delegation; shares
  the same listener Set, so registration order across both APIs determines
  invocation order. Returned unsubscribe identical to `on('transition', ...)`.

### Stability

- New file: `STABILITY.md`. Documents the three tiers: **stable**
  (everything shipped 0.1.0–0.2.1), **experimental** (`sub`, `subImpl`,
  `subRuntime`, `SubMachineError`, `SubMachineDef`), **draft**
  (`historyState`, v0.4 candidate).

### Changed (positioning)

- **README "Capabilities / Limitations" table**: "Hierarchical / compound
  states" moved out of the "Won't do" column. Added on the "Will do" side
  as "Hierarchical sugar via `state.sub` (experimental since 0.3.0)".
- **README Lifecycle Invariants**: documented the sub-machine ordering —
  parent `step()` lifecycle (exit / actions / entry) runs first, then
  child dispose → child init → snapshot commit → middleware → effects →
  `transition` emit.

### Build & tooling

- **`scripts/check-size.mjs`**: core gzip budget raised 3,700 → 4,700 B
  to absorb sub-machine lifecycle, `SubMachineError`, and `onTransition`
  sugar (measured at 4,465 B). `pbt` budget raised 4,600 → 5,500 B because
  `pbt/properties.ts` imports `createRuntime` from `runtime.ts`; the new
  sub-machine code is pulled in transitively (measured at 5,228 B).

### Compatibility

This release is **non-breaking** for v0.2.1 callers who do not opt into
the new sub-machine fields. All existing API signatures, error types, and
runtime behaviour are byte-identical.

## [0.2.1] — 2026-05-28

### Security

- **Resolve two Dependabot moderate advisories** on the transitive dev-only graph by upgrading `vitest` 2.1.0 → 4.1.7 and `@vitest/coverage-v8` 2.1.9 → 4.1.7. Adds `vite` 8.0.14 as a direct devDependency to satisfy vitest 4's peer range (`^6 || ^7 || ^8`). These are dev-only — runtime surface unchanged. Same fix as `aibridgejs` 0.1.2.
  - [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) `esbuild <=0.24.2` CORS development server data leak (fixed in 0.25.0).
  - [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) `vite <=6.4.1` path traversal in optimized deps `.map` handling (fixed in 6.4.2 / 7.3.2 / 8.0.5).

### Changed

- **Coverage threshold relaxed**: statements 100 → 95 in [vitest.config.ts](vitest.config.ts). Vitest 4 with v8 coverage scores defensive race-recovery if-guards (e.g. `if (!current) return;` in timeout/abort handlers) as separate statements that are not deterministically reachable. Lines and functions stay at 100%; branches stays at 90%.
- **`prepublishOnly` now includes `verify:llms`** so llms-full.txt drift is caught at publish time as well as CI.
- **README opening unified across the ai*js family**: five-badge shields row, one-line tagline as blockquote, ecosystem footer.

Runtime surface unchanged. Production bundles are byte-identical to 0.2.0.

## [0.2.0] — 2026-05-28

### Added

- **Async-guard detection**: `evalGuard` and `defineMachine`'s validation pass now throw on async guards. TypeScript already prevents the typed case, but a JS caller or a cast could slip an async guard through and silently pass every check (a thenable is truthy). The new check fails loudly:
  - **Definition time** (inline `async` guard) → `InvalidDefinitionError` from `defineMachine`'s `validateDefinition`.
  - **Runtime** (string-ref or cast guard whose return value is thenable) → `AsyncGuardError` from `evalGuard`. The thenable check uses `typeof x?.then === "function"`, so cross-realm Promises (iframe / worker / vm) and user-defined PromiseLike values are also caught — not just same-realm `instanceof Promise`.
  - New exports from `aifsmjs`: `AsyncGuardError`, `isAsyncGuardFn`.
  - README's "Capabilities / Limitations" table updated to reflect the new runtime guarantee.

### Fixed (correctness)

- **`send()` transition payload AND `notify()` listeners are captured pre-reentry** ([src/fsm/runtime.ts](src/fsm/runtime.ts)): the `next` field of the emitted `'transition'` event, the effect dispatch context, and the snapshot delivered to `subscribe()` listeners are all now read from a captured local `committed` snapshot rather than the outer mutable `snapshot` variable. Closes a race where a reentrant `send()` inside an effect handler or subscriber would race ahead and the outer payload / later subscribers in the same notify pass would end up pointing at the reentry's snapshot.
- **`evalGuard` falls back to `<inline>` for anonymous-arrow guards** ([src/fsm/evaluator.ts](src/fsm/evaluator.ts)): switched `??` to `||` so an empty `Function.prototype.name` falls back instead of producing `guard "" must be sync;`.
- **README + README_ZHTW + llms-full.txt** now describe the two error paths separately (`InvalidDefinitionError` at definition time vs `AsyncGuardError` at runtime) instead of conflating them.

### Changed (positioning + meta)

- **`package.json#description`** rewritten from «for web game development» to lead with the broader use case set (multi-step forms, checkout funnels, auth flows, tutorials, scene flow). The README's "Primary audience" paragraph already moved away from game-only framing in v0.2.0; the package metadata now matches.

### Build & tooling

- **`verify:llms` is now build-agnostic** ([scripts/build-llms-full.mjs](scripts/build-llms-full.mjs)): the script accepts `--check` which builds the file in memory and compares against disk, exit 1 on diff. The previous form used `git diff --exit-code -- llms-full.txt` after running the build, which failed any time the working tree had uncommitted changes (not just llms-full.txt drift). The new form works identically pre-commit and in CI.
- **Per-subpath gzip budgets raised** ([scripts/check-size.mjs](scripts/check-size.mjs)): core 3500 → 3700 B and replay 1600 → 1800 B to absorb the AsyncGuardError + thenable detection cost; pbt 4500 → 4600 B for a small symbol additions. All entries still tracked at ≥95% headroom.

### Added (examples)

- `examples/03-checkout-funnel` — e-commerce checkout funnel with guarded staging, payment / analytics effects, and a `replay()` round-trip. Demonstrates that aifsmjs models classic web UX flows with no canvas / game loop involvement.
- `examples/04-form-wizard` — multi-step form wizard with back / next / jump-to-step navigation, per-step validation, and draft persistence via the `persist` middleware.

### Changed (positioning)

- `README.md` and `README_ZHTW.md`'s "Primary audience" paragraph now leads with stateful web flows (multi-step forms, checkout funnels, auth flows, tutorials, document workflows) and frames games as one application of the same pattern. The core remains environment-neutral; the only opt-in dependency is `fast-check` for the `aifsmjs/pbt` PBT adapter.

### Compatibility

This release is **non-breaking at runtime** for users who already wrote sync guards. Async guards previously slipped through and silently passed; they now throw. If you relied on this accidental behaviour, move the async work into an effect (`enq.effect(...)`) and dispatch a follow-up event when the work completes — the pattern is documented in the README's "Common pitfalls" table.

## [0.1.2] — 2026-05-28

### Fixed

- **Memory**: `runtime.on(type, fn, { signal })` previously left an
  abort listener attached to the external `AbortSignal` after
  `runtime.dispose()`. The listener (and its closure over the user's
  callback) was retained until the signal eventually fired or was
  garbage-collected. `dispose()` now removes each abort listener from
  the signal it was attached to, and the unsubscribe function returned
  by `on()` does the same on manual unsubscribe.

### Internal

- Narrowed `dispatchEffects` event parameter from `Evt | ResetEvent`
  to `Evt`; the function is only reached via `send()`. Removed the
  corresponding `as Evt` cast.
- Removed a redundant `snapshot.context as Ctx` cast in `step()`.

No public API changes; existing 0.1.1 callers run unchanged. Core gzip
3296 B → 3401 B (97% of 3500 B budget).

## [0.1.1] — 2026-05-28

### Changed

- **Release pipeline**: switched to npm OIDC trusted publisher. Releases
  now ship with provenance attestation generated from the GitHub Action
  via `id-token: write` + `--provenance`; no long-lived `NPM_TOKEN`
  needed. The `Publish to npm` workflow is unchanged from v0.1.0; see
  CONTRIBUTING for the `pnpm version patch && git push --follow-tags`
  flow.

No code changes vs v0.1.0; runtime behaviour, API surface, and bundle
sizes are identical (core gzip 3.30 KB / 3.5 KB budget).

## [0.1.0] — 2026-05-28

Initial public release.

### Added

- **fsm/** (source folder, internal) — `defineMachine`, `setup<Ctx, Evt>()`
  curried builder for inferred States, `createRuntime`, `step()` pure
  function with fixed `guards → exit → action → entry` lifecycle order.
  Runtime exposes `dispose()`, `reset(event?)`, `disposed`, `signal`
  (internal `AbortController` lifetime) — see the Lifecycle Protocol section
  of README. `RuntimeDisposedError` thrown on post-dispose calls. Snapshot
  is frozen (deep-frozen in dev). Implementations injected at runtime via
  string refs.
- **`aifsmjs/guards`** — `and / or / not / stateIn` higher-order combinators
  with short-circuit evaluation. Both string-ref and inline `Guard` supported.
- **`aifsmjs/effects`** — `Enqueuer` API (`enqueue.effect(type, payload?)`)
  and a standalone `runEffects()` dispatcher. Effects are descriptors, not
  callbacks, so they remain serializable. `EffectHandler` receives the
  runtime's `AbortSignal` in `args.signal`. `runEffects()` accepts
  `args.signal` as optional — standalone callers may omit it and the
  dispatcher supplies a never-aborting placeholder.
- **`Runtime.reset()`** — listeners notified only when `prev.value !==
  initial.value` (parity with `send()`); middleware always observes the
  call regardless. The triggering event is exposed on
  `MiddlewareContext.event` as `Evt | ResetEvent`. The sentinel
  `RESET_EVENT_TYPE` (`"@@aifsmjs/RESET"`) is exported for discrimination.
- **`aifsmjs/inspect`** — Koa-style read-only middleware pipeline. Built-in
  `logger`, `persist`, and `recorder` middlewares. Middleware cannot alter a
  transition outcome.
- **`aifsmjs/replay`** — Pure event-log fold via `step()`. Never dispatches
  effects; suitable for PBT, time travel, and incident reproduction.
- **`aifsmjs/pbt`** — `fast-check` `fc.commands` adapter
  (`commandsFromMachine`) plus six generic property tests
  (`snapshotAlwaysFrozen`, `unknownEventNoOp`, `reachableStatesSubsetDeclared`,
  `replayEqualsFold`, `guardsFalseNoTransition`, `assignDoesNotMutate`) and an
  `assertAll` convenience runner. `fast-check` listed as optional peer.
- **`aifsmjs/timer`** — `after(ms, fn, { signal })` returning a cancellable
  handle, plus `createScheduler()` for bundled cancellation. `AbortSignal`
  listeners registered with `{ once: true }` to avoid leaks.
- TypeScript build with `strict + noUncheckedIndexedAccess +
  exactOptionalPropertyTypes`; dual ESM/CJS output via tsup.
- Bilingual README (Traditional Chinese canonical + English mirror) with an
  AI-Agent Reading Guide section, Lifecycle Invariants contract, and
  comparison table against XState v5 / Robot3 / @xstate/store / Zag.js.
- 94 example-based tests (vitest) plus PBT smoke runs against a traffic-light
  fixture.

### API additions for ai*js ecosystem alignment

- **`createMachine(def, impl, opts?)`** — single-factory convenience that
  composes `defineMachine` + `createRuntime`. Spec-style entry point from
  the ai*js micro-runtime review; the curried `setup().defineMachine` form
  remains for States inference, and explicit `defineMachine<Ctx,Evt,States>`
  remains as an escape hatch.
- **`runtime.snapshot()`** — alias for `runtime.getSnapshot()`; documented
  as the preferred name going forward.
- **`runtime.can(event)`** — predicate that returns `true` iff sending the
  event would fire a transition. Reuses `evalGuard`; guards must be pure
  for `can` and `send` to agree.
- **`runtime.on(type, listener, { signal?, once? })`** — `EventTarget`-style
  typed event API. Channels: `'transition'` (after a state-changing `send`
  or `reset`), `'error'` (async effect handler rejections), `'dispose'`
  (fires once on teardown). `subscribe(listener)` is unchanged and still
  preferred for `useSyncExternalStore`.

Core gzip grew from 2.87 KB to ~3.3 KB; the size budget script raised the
core cap to 3.5 KB with rationale in `scripts/check-size.mjs`.

### Documentation restructure

- `README.md` is now the canonical English README; the Traditional Chinese
  mirror moved to `README_ZHTW.md`.
- Added `llms.txt` and `llms-full.txt` following the [llmstxt.org](https://llmstxt.org/)
  convention so LLM agents can ground in the project surface with one fetch.
  `llms-full.txt` is generated by `scripts/build-llms-full.mjs`; `pnpm
  verify:llms` re-runs the generator and diffs to catch drift.
- New "Design choices" section in both READMEs explains why send is sync,
  guards are sync, effects are descriptors, why two factory forms exist,
  and why `on` and `subscribe` both ship.

### CI guarantees

- **Coverage threshold**: 100% statements / 100% lines / 100% functions /
  ≥90% branches, enforced via `@vitest/coverage-v8` thresholds (actual on
  v0.1.0 release: 100/100/100/98.81). Defensive invariant-guard branches
  carry `/* v8 ignore */` annotations with rationale comments.
- **Per-subpath gzip size budget** (verified by `scripts/check-size.mjs`):
  core ≤3 KB · replay ≤1.6 KB · pbt ≤4.5 KB · guards / effects / inspect /
  timer ≤1 KB each. Tarball measured at ~98 KB / 48 files.

### Out of scope (v1)

Hierarchical / compound states, parallel state regions, actor invocation
(async), tick/game-loop hook, ECS / Pixi bridges. See Roadmap in README.
