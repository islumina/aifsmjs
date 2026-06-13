# aifsmjs Review

Current review state after the 2026-06-10 ai*js pass.

## Current Known Issues / Backlog

| Priority | Area | Status | Notes |
| --- | --- | --- | --- |
| P2 | Post-commit throws | Documented | Middleware and synchronous effect throws occur after snapshot commit. Consider opt-in safe dispatch if callers need atomic notification. |
| P3 | `setup().defineMachine()` inference | Watch | Current code uses `NoInfer<States>` to preserve state union inference. Keep regression tests for exact optional property setups. |
| P3 | Sub-runtime stale handles | Documented | External child disposal can leave `subRuntime()` returning a disposed handle until parent re-entry. |

## Fixed Summary

- Async guards are rejected at definition/runtime boundaries.
- Reset snapshot integrity and immutable snapshot behavior are covered.
- Scheduler abort listeners are cleaned up after cancel/fire.
- Sub-machine child abort/dispose listener leaks were fixed.

## Verification Baseline

- `pnpm typecheck`
- `pnpm test`
- `pnpm verify:docs`
- `pnpm verify:exports`
- `pnpm verify:dist`
- `pnpm verify:llms`
- `pnpm check:size`
