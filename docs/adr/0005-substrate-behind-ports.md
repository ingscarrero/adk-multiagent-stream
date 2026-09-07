# ADR-0005: Substrate sits behind ports with emulated defaults; storage and delivery are one port

**Date:** 2026-08-31 · **Status:** accepted (PRs #1 and #2)

## Context

The repo runs with no external services: sessions in memory, keyword matching
in place of retrieval, a trusted header in place of identity, an in-process
array in place of an event log. Emulation is the right default for a
reference project, but an emulation buried in a constructor is
indistinguishable from an assumption, and the first thing a reader asks is
"which parts are real?"

## Decision

Every capability the app does not implement itself is reached through an
interface in `packages/providers` — `sessions`, `knowledge`, `identity`,
`eventStream` — with an emulated adapter by default and a real one behind a
config flag (`PROVIDER_*`). `GET /api/health` reports which adapter is live,
so the boundary is observable at runtime rather than asserted in a document.

**Storage and delivery of events are one port, not two.** An earlier split
into `eventLog` and `fanout` advertised a seam no implementation has: only
"memory + in-process" and "shared + shared" are coherent, and every real
provider (Redis Streams, Kafka, NATS JetStream) serves both from one
primitive. The port exposes `append`, `open` (replay + tail in one call, to
close the race between them), `oldestOffset` (what overrun detection reads)
and `drop` (what the idle sweep needs).

Ports are tested through **contract suites** (`knowledgeContract`,
`streamContract`) that every adapter must pass, so a real adapter diverging
from the emulated one surfaces as a failing test.

Rules: emulated is the default; CI runs fully emulated; a port exists only
where a real implementation is in view; the health endpoint tells the truth.

## Alternatives

| | Why it lost |
|---|---|
| Hard-wire the emulations | Fastest, but the emulated/real line is invisible and every swap is a refactor |
| Ports for everything, including things with no real adapter in view | Interfaces invented for symmetry prove nothing — "architecture cosplay" |
| Separate log and fan-out ports | See above; the split does not correspond to any provider |

## Consequences

- Swapping an adapter is a config change; the calling code does not move.
- Only the emulated adapters and the Gemini model are written. Switching any
  other flag fails at startup with "catalogued but not implemented yet" —
  deliberately, rather than silently falling back.
- One capability has **no port at all**: the message store
  ([ADR-0006](0006-event-log-is-not-the-message-store.md)).
