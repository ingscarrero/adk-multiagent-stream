# ADR-0004: ADK is confined to the server; the client and the protocol are framework-free

**Date:** 2026-08-31 · **Status:** accepted

## Context

`@google/adk` is the agent runtime: it builds the agent graph, runs it, and
emits `Event`s. Those events could be forwarded to the browser as-is, which is
the least code. It would also couple every UI decision, every test and every
Playwright assertion to a framework at v2.0.0 that is already deprecating the
agents this repo composes with.

## Decision

Nothing in `apps/web` or `packages/protocol` imports `@google/adk`. The wire
contract is a zod-validated `FeedEvent` union owned by `packages/protocol`.
Server-side, `apps/server/src/adk-adapter.ts` is the single place ADK `Event`s
become `FeedEvent`s; the runner assigns `seq` after translation.

Four ADK behaviours the adapter depends on are pinned by named tests so an
upgrade breaks a test rather than the app: `transfer_to_agent` takes
`agentName`; transfer rewrites history into `"For context:"` user messages;
`BIDI` throws; `SequentialAgent`/`ParallelAgent` are deprecated but kept.

## Alternatives

| | Why it lost |
|---|---|
| Forward ADK events to the browser | Client coupled to ADK's event shape and version; reducer untestable without ADK |
| Translate in the browser | Same coupling, plus the translation logic duplicated in every client |

## Consequences

- The reducer is testable with array literals; the browser suite asserts on
  the contract, not on ADK.
- Replacing ADK means rewriting the adapter and `packages/agents`, and
  touching nothing the user can see.
- ADK is still imported across `packages/agents`, `packages/providers`
  (`BaseSessionService`) and the server — it is the runtime, not a detail. The
  invariant is that it never reaches the client.
