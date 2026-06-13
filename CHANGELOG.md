# Changelog

All notable changes to aifsmjs are summarized here.

## [Unreleased]

- Documentation-only slimming pass across README, stability notes, review backlog, and LLM context.
- Known follow-ups: preserve `setup().defineMachine()` inference tests and decide whether post-commit synchronous middleware/effect throws need an opt-in safer mode.

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
