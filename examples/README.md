# aifsmjs examples

Runnable demos that exercise the public API end-to-end. Each example imports
from `../../src` so it always runs against the working tree (not the published
package).

## Run

```bash
pnpm install
pnpm example:traffic-light    # 01-traffic-light
pnpm example:approval         # 02-approval-workflow
pnpm example:checkout-funnel  # 03-checkout-funnel
pnpm example:form-wizard      # 04-form-wizard
```

## Index

| # | Example | What it shows | Real-world pattern |
|---|---|---|---|
| 01 | [traffic-light](https://github.com/islumina/aifsmjs/blob/main/examples/01-traffic-light/index.ts) | Minimal `setup → defineMachine → createRuntime → send` loop with `assign` and a snapshot subscriber. | Cyclic scene flow (loading → menu → playing → result → loading) — or any 3-state cycle. |
| 02 | [approval-workflow](https://github.com/islumina/aifsmjs/blob/main/examples/02-approval-workflow/index.ts) | Multi-candidate guarded transitions (`and([...])`), effects + handlers, `persist` + `recorder` middleware, and `replay()` to reproduce the final snapshot. | Document approval, ticket triage, turn-based games with branching outcomes + post-mortem replay. |
| 03 | [checkout-funnel](https://github.com/islumina/aifsmjs/blob/main/examples/03-checkout-funnel/index.ts) | E-commerce checkout: cart → shipping → payment → review → confirmed. Per-stage validation as guards, payment + analytics as effects, full replay of the funnel. | Plain web app — no canvas, no game loop. Demonstrates that aifsmjs models classic UX funnels. |
| 04 | [form-wizard](https://github.com/islumina/aifsmjs/blob/main/examples/04-form-wizard/index.ts) | Multi-step form wizard with back / next / jump-to-step navigation. Per-step validation, draft persistence via the `persist` middleware. | Account onboarding, settings editor, multi-page survey. |

## Notes

- Examples import from `../../src/...` (TypeScript sources) and are run by
  `tsx`, so type-checks happen at run time too.
- For real applications, import from `aifsmjs`, `aifsmjs/guards`,
  `aifsmjs/inspect`, etc.
