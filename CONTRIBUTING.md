# Contributing

Thanks for looking. This is a small, opinionated reference project, so the bar
for a change is "does it keep the documented guarantees, and is it tested at
the layer where it can fail?" rather than "is it a feature".

## Setup

```bash
pnpm install     # Node 22+, pnpm 10+; downloads Chromium for Playwright
pnpm dev         # http://localhost:5173, fully offline (MODEL_MODE=scripted)
```

No API key, no services. `pnpm dev:demo` slows the scripted model down so you
can watch it; `pnpm dev:recovery` runs a 40-event buffer so reconnect and
resync are reachable by hand. Both are described in
[docs/TESTING.md](docs/TESTING.md#testing-by-hand-two-things-the-defaults-hide).

## The gate

CI runs exactly this, in this order:

```bash
pnpm typecheck   # tsc --noEmit, per package
pnpm lint        # eslint, type-aware
pnpm test        # vitest, node + jsdom projects
pnpm eval        # the agent behavioural evals
pnpm test:e2e    # playwright: chromium, firefox, recovery
```

`pnpm check` runs all of it. Coverage floors are enforced by
`pnpm test -- --coverage` (see `vitest.config.ts`); a change that drops
coverage below a floor fails CI.

## Where a change goes

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The two rules that
matter most:

1. **`apps/web` and `packages/protocol` never import `@google/adk`.** The only
   place ADK events become wire events is `apps/server/src/adk-adapter.ts`.
2. **A status transition is a table entry.** Add it to
   `packages/protocol/src/status.ts` and the 64-pair test will tell you what
   else changed.

If a change touches the wire contract, update
[docs/STREAMING-CONTRACT.md](docs/STREAMING-CONTRACT.md) in the same PR. If it
adds or removes a limitation, edit [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
— that file is the only place a known gap is allowed to live. Decisions with
lasting consequences get an ADR in [docs/adr/](docs/adr/).

## Tests

Put the test at the lowest layer that can fail:

| The change is about | Test it in |
|---|---|
| ordering, dedup, gaps, status | `apps/web/src/feed/reducer.test.ts` — array literals, no browser |
| what ADK emits | `packages/agents/src/agents.test.ts` — real `InMemoryRunner` |
| the ADK → wire translation | `apps/server/src/adk-adapter.test.ts` — hand-built events |
| HTTP, SSE frames, reconnect | `apps/server/src/stream.test.ts` — real server, ephemeral port |
| a component's rendering rules | `apps/web/src/feed/*.test.tsx` — Testing Library |
| the whole stack | `e2e/specs/*.spec.ts` — no sleeps, no selectors outside `pages/` |

Every test runs against `ScriptedLlm`. Do not add a test that needs a key.

## Pull requests

- Branch from `main`; `main` is protected and takes PRs only.
- One logical change per commit, imperative subject line.
- Copilot reviews every PR automatically. Address each comment or explain why
  not before asking for a human review.
- The PR description should say what changed, why, and how it was verified.

## Style

Prettier is not configured; match the surrounding code (two-space indent,
single quotes, trailing commas, 100-column soft limit). Every source file
opens with a docblock saying what it owns and why it is shaped that way —
keep that convention when adding a file.
