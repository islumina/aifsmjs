# Code Review — aifsmjs

| Field       | Value                                        |
|-------------|----------------------------------------------|
| Repo        | aifsmjs                                      |
| Version     | 0.5.1                                        |
| Branch      | claude/adoring-ptolemy-OGonc                 |
| Head SHA    | 83d513fe83d06adb81ecc36e51532d3686d7e1f4     |
| Date        | 2026-06-03                                   |
| Reviewer    | sonnet                                       |

---

## Verdict / Summary

The codebase is well-structured, strictly typed, and demonstrably correct across its core
invariants. All seven baseline gates pass both before and after fixes. The four safe fixes
applied are documentation-only corrections: a nonexistent API reference in the pbt example,
an incorrect `enqueue.effect` call signature in README_ZHTW, an inaccurate `structuredClone`
claim for middleware context, and an overly broad "never throws" claim for `step()`.

No behavioral bugs were found. The sub-machine lifecycle ordering, rollback semantics on
child init/dispose failures, `reset()` snapshot integrity, snapshot immutability, guard
async-detection at both definition time and runtime, and replay determinism are all
correctly implemented and exercised.

The three medium-severity findings are doc/contract gaps rather than runtime defects: the
README's `Runtime` interface snippet omits `can()`, `on()`, `onTransition()`, and
`subRuntime()`; middleware silently permits skipping `next()` without enforcement or docs;
and the `FsmModel.reached` field lacks a `readonly` modifier allowing unintended external
mutation.

---

## Gate Results

| Gate              | Baseline   | After-fix  | Notes                                      |
|-------------------|------------|------------|--------------------------------------------|
| typecheck         | PASS       | PASS       | tsc --noEmit, no errors                    |
| lint              | PASS       | PASS       | biome check src test, 39 files, no fixes   |
| build             | PASS       | PASS       | Dual ESM/CJS + DTS, 7 subpaths             |
| verify:exports    | PASS       | PASS       | All 7 subpaths resolved                    |
| verify:llms       | PASS       | PASS       | 52.4 KB (up from 51.9 KB after doc fixes)  |
| check:size        | PASS       | PASS       | All 7 entries within budget (see below)    |
| coverage          | PASS       | PASS       | 99.16% stmts / 94.66% branch / 100% funcs / 100% lines |

### Subpath gzip sizes (after-fix, unchanged)

| Subpath             | gzip    | Budget  | Used |
|---------------------|---------|---------|------|
| dist/index.js       | 4372 B  | 4700 B  | 93%  |
| dist/guards/index.js| 467 B   | 1000 B  | 47%  |
| dist/effects/index.js| 462 B  | 1000 B  | 46%  |
| dist/inspect/index.js| 329 B  | 1000 B  | 33%  |
| dist/replay/index.js| 1704 B  | 1800 B  | 95%  |
| dist/pbt/index.js   | 5133 B  | 5500 B  | 93%  |
| dist/timer/index.js | 679 B   | 1000 B  | 68%  |

---

## Safe Fixes Applied

| # | File | Kind | Description |
|---|------|------|-------------|
| 1 | README.md | doc typo / broken API ref | Replaced nonexistent `properties.runDeterministic(...)` with real API calls: `properties.replayEqualsFold(...)` and a complete `commandsFromMachine` example. Added missing imports (`createRuntime`, `initialModel`). |
| 2 | README_ZHTW.md | doc typo / broken API ref | Same fix as #1 for the Traditional Chinese mirror. |
| 3 | README_ZHTW.md | doc typo / incorrect signature | `enqueue.effect({ type, payload })` corrected to `enqueue.effect(type, payload?)` to match the actual two-argument `Enqueuer.effect` signature. |
| 4 | README.md | doc inaccuracy | `step() … never throws` claim qualified: `step()` does throw `UnknownGuardError`, `UnknownActionError`, and `AsyncGuardError` on misuse. The existing inline source comment (`The function is pure: it never dispatches effects and never mutates inputs`) is accurate; the README description was the gap. |
| 5 | README.md | doc inaccuracy | `structuredClone`d claim for middleware context corrected to `deep-frozen` — the implementation uses `deepFreeze()`, not `structuredClone()`. |
| 6 | README_ZHTW.md | doc inaccuracy | Same `structuredClone + freeze` → `deep-frozen` fix for the Traditional Chinese mirror. |
| 7 | README.md + README_ZHTW.md + llms-full.txt | llms regeneration | `pnpm build:llms` re-run after README edits; llms-full.txt verified up-to-date. |

---

## Findings by Severity

### High

_None._

### Medium

**M1 — README Runtime interface snippet omits four stable public methods**
- File: `README.md` lines 184–192 / `README_ZHTW.md` lines 183–191
- The code-block `interface Runtime<C, E, S>` in the Core API section documents only 7 of
  11 stable `Runtime` members. Missing: `can(event)`, `on(type, fn, opts)`,
  `onTransition(handler, opts)`, and `subRuntime()`. All four are stable per `STABILITY.md`.
  A caller reading only the README would not discover `can()`, which is the primary
  predicate for optimistic UI, or `on('transition')` / `onTransition()`, which is the
  recommended typed subscription API.
- Recommendation: Extend the interface snippet or add a "Since 0.3.0" additions table
  immediately after. This is a docs-only change; no code change required.

**M2 — Middleware can silently skip `next()` with no enforcement or documented contract**
- File: `src/fsm/runtime.ts` line 129 / `src/inspect/index.ts`
- `composeMiddleware` detects `next()` called _twice_ (throws) but does not detect or
  warn when `next()` is _never_ called. A middleware author who forgets `next()` silently
  drops the rest of the chain. The README states "next() must be called; the return value
  carries no meaning" but there is no enforcement. In contrast, the "called twice" path is
  enforced. Since middleware cannot alter transition outcomes this is a DX trap, not a
  correctness bug, but it contradicts the documented contract.
- Recommendation (findings-only, behavioral): Add an after-chain check — if `index < middleware.length`
  after `dispatch(0)` returns (i.e. some middleware never called `next()`), throw or emit a warning. This is an observable-behavior
  change and requires a decision on whether to `throw`, `console.warn`, or emit `'error'`.

**M3 — `FsmModel.reached` field in `pbt/commands.ts` is mutable from outside**
- File: `src/pbt/commands.ts` line 14
- `FsmModel.reached: Set<States>` lacks the `readonly` modifier. Since `FsmModel` is a
  mutable model type (fields are assigned in `SendCommand.run()`), a caller using
  `commandsFromMachine` could accidentally assign a new `Set` to `model.reached` between
  commands, breaking `reachableStatesSubsetDeclared`. The fix is to type it as
  `readonly reached: Set<States>` which prevents the property from being reassigned while
  keeping `Set.add()` callable (a `readonly` property can still be mutated through
  methods; use `ReadonlySet` if full immutability is desired). Harmless in current
  tests but a latent DX trap.
- Recommendation (findings-only): Change `reached: Set<States>` to
  `readonly reached: Set<States>` in `FsmModel`. This is a type-only change;
  runtime behavior is identical. However it touches a public type export, so classify as
  findings-only until confirmed non-breaking.

### Low

**L1 — `defineMachine` doc comment claims it "Freezes the whole definition"**
- File: `README.md` line 173, `README_ZHTW.md` line 172
- `defineMachine` validates but does not freeze the definition object (it returns the
  same reference). `Object.freeze` is only applied to snapshots by `freezeSnapshot`. The
  comment "Pure data builder. Freezes the whole definition…" is inaccurate; no freeze
  happens in `validateDefinition` or `defineMachine`.
- Recommendation: Remove "Freezes" from the doc comment in both READMEs.

**L2 — `sub-machine.test.ts` test G5a: mutates a frozen def to force a failure path**
- File: `test/fsm/sub-machine.test.ts` lines 524–535
- `(workingDef as any).states.idle.sub = innerBadSub` patches a validated definition
  object to make `reset()` fail. While effective, it patches after-the-fact and relies on
  the fact that `defineMachine` does not deep-freeze the definition. If a future version
  deep-freezes the def, this test will throw "Cannot assign to read only property" before
  reaching the assertion. The test intent is valid; the technique is fragile.
- Recommendation: Refactor using a factory that returns a pre-constructed mutable def
  object that bypasses `defineMachine` (similar to the Group I `any` cast strategy).

**L3 — `llms.txt` (short index file) not verified for content drift vs. README**
- File: `llms.txt` (repo root)
- `verify:llms` only checks `llms-full.txt`. The shorter `llms.txt` (quick-index file)
  is not regenerated by `build:llms` and may drift from the README over time. Currently
  the drift is acceptable but there is no gate for it.
- Recommendation: Either include `llms.txt` in the `build:llms` regeneration or add a
  note in the contributing guide that it must be manually updated.

---

## Findings-Only Backlog

| ID | Severity | Area | Title |
|----|----------|------|-------|
| M1 | M | Docs / API | README Runtime interface snippet incomplete (4 stable methods missing) |
| M2 | M | Middleware contract | Middleware silently permitted to skip `next()` with no enforcement |
| M3 | M | PBT types | `FsmModel.reached` missing `readonly` modifier |
| L1 | L | Docs | `defineMachine` doc comment incorrectly claims it freezes the definition |
| L2 | L | Tests | G5a test patches a frozen def; fragile if def ever deep-freezes |
| L3 | L | Docs / llms | `llms.txt` (short index) not covered by verify:llms gate |

---

## Appendix

### Commands run

```
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm verify:exports
pnpm verify:llms
pnpm check:size
pnpm coverage
pnpm format          (no changes)
pnpm build:llms      (after README edits)
pnpm lint            (re-run after fixes — pass)
pnpm typecheck       (re-run after fixes — pass)
pnpm build           (re-run after fixes — pass)
pnpm check:size      (re-run after fixes — pass)
pnpm verify:llms     (re-run after fixes — pass)
pnpm coverage        (re-run after fixes — pass)
```

### Environment

| Tool  | Version  |
|-------|----------|
| node  | v22.22.2 |
| pnpm  | 9.12.3   |
