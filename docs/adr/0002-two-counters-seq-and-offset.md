# ADR-0002: Two counters — per-thread `seq` and per-session `offset`

**Date:** 2026-08-31 · **Status:** accepted

## Context

With every thread on one connection ([ADR-0001](0001-one-multiplexed-sse-connection.md)),
two different questions need a number: *in what order did this thread's
events happen?* and *where should a reconnecting client resume?* One counter
is the obvious answer and the classic bug.

## Decision

- **`seq`** is per **thread**, monotonic from 1, assigned by the runner at the
  single publish point. It is the ordering guarantee and the only thing the
  reducer uses to order, dedupe and detect gaps.
- **`offset`** is per **session**, the SSE `id:` field, monotonic from 1. It
  drives `Last-Event-ID` resume and nothing else.
- `ts` is wall-clock for display only, never for ordering.

`thread.created` is always `seq: 1`. `message.complete` carries the full text
so a lost delta is self-healing. `thread.error` precedes the terminal status
so a consumer that stops at terminal already has the reason.

## Alternatives

| | Why it lost |
|---|---|
| One global counter | Cannot express per-thread order once threads interleave; the reducer would see gaps that are other threads' events |
| One per-thread counter | Cannot drive `Last-Event-ID`, which is one value per connection |
| Timestamps | Coarse, non-monotonic, and two events per millisecond are common |

## Consequences

- Two concurrent threads both emit `seq` 1, 2, 3… — correct, because order
  is only defined within a thread.
- The reducer is a pure function over `(threadId, seq)` and is tested with
  array literals.
- Replay after reconnect can overlap; the reducer drops already-applied
  `seq`s and buffers ahead-of-gap events until the gap closes.
