# ADR-0006: The event log is not the message store; recovery rebuilds from a snapshot, not a watermark

**Date:** 2026-08-31 · **Status:** accepted (PR #3; the store itself is planned — L7)

## Context

Events live in a bounded per-session log (`EVENT_RETENTION`, default 500).
That log is also the only place agent messages exist. A client reconnecting
inside the window gets an exact replay; one reconnecting outside it — or
loading the page fresh after a long session — cannot be served from the log.

The first implementation emitted a `resync` frame the client never listened
for; threads vanished silently. The second treated the snapshot's `lastSeq` as
a watermark and discarded the very replay that followed. The third
reconnected with no resume point and looped forever.

## Decision

**Two decisions, one about shape and one about mechanism.**

1. **A log and a store are different things and the repo has only the first.**
   A log answers *what happened next* over a window — sequential, truncated,
   events. A store answers *what is this thread* — keyed, permanent,
   messages. Using the log *as* the store is the one architectural conflation
   in the repo, recorded as [L7](../LIMITATIONS.md#l7) rather than papered
   over. Persisting the log (a Redis adapter) is **not** the fix: it makes the
   wrong-shaped store durable. The fix is a `messageStore` port written at
   settle points only — never `message.delta` — after which the store is
   truth and the stream is an optimisation.

2. **Recovery is a snapshot plus a replay, and the snapshot is a hint.** On
   overrun — resuming below `oldestOffset`, *or* connecting fresh to a session
   whose start has rolled out — the server sends `resync {from}`. The client
   fetches `GET /api/threads` (identity, status and `lastSeq` per thread;
   never content), rebuilds missing threads as shells marked
   `awaitingResume`, and reconnects at `from − 1`. A rebuilt thread does
   **not** adopt `lastSeq` as a watermark; it accepts the next event wherever
   it lands and learns from that event's `seq` whether a prefix was lost.
   `lastSeq` is used only to decide whether to warn.

This is the Slack/Discord gateway shape — a resumable socket plus a REST
backfill — and the Kafka/Postgres-WAL shape underneath: a truncated ordered
log in front of keyed permanent tables.

## Alternatives

| | Why it lost |
|---|---|
| Drop the log, keep only a store plus a liveness socket | Conventional for chat, but tool calls, transfers and status transitions are worth consuming by things that are not the UI (evals, audit, billing); the log stays as the integration point |
| Persist the log and call history solved | A transcript still expires with the window |
| Snapshot `lastSeq` as a watermark | Discarded the replay; shipped, and reverted |
| Reconnect with no resume point after `resync` | `oldestHeld > 1` is still true, so the server resyncs again — an infinite loop; shipped briefly, and reverted |

## Consequences

- Today the snapshot returns identity and no messages; the UI says
  *"Messages for this thread are no longer available"* rather than passing a
  thread off as complete. A long session degrades into empty cards
  ([L16](../LIMITATIONS.md#l16)).
- Adding the store changes what the snapshot returns and nothing about the
  `resync` frame, the reducer's gates, or the status machine.
- The fix is tested at three layers and in the browser against a 40-event
  buffer, because each earlier bug lived in the seam between layers that were
  individually green.
