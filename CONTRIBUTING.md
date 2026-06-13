# Contributing to aifsmjs

Keep the deterministic core small and make lifecycle changes test-heavy.

## Local workflow

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm verify:docs
pnpm build:llms
pnpm verify:llms
pnpm verify:exports
pnpm verify:dist
pnpm check:size
```

Run `pnpm lint` before PRs. If docs change, regenerate `llms-full.txt`.

## Rules

- Preserve `step()` purity and replay determinism.
- Keep guards synchronous; route I/O through effects and events.
- Add tests for runtime commit ordering, sub-machine lifecycle, reset, dispose, and scheduler cancellation.
- Keep subpath imports tree-shakeable.
- Discuss public type inference changes before implementation.

## License

MIT
