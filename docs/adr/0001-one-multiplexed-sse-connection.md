# ADR-0001: One multiplexed SSE connection carries every thread

**Date:** 2026-08-31 · **Status:** accepted

## Context

The product is several agent threads streaming at once. Each needs a live,
ordered feed of token deltas, tool calls and status changes into one browser
tab. The obvious shapes are one SSE stream per thread, one multiplexed SSE
stream per session, or a WebSocket.

Browsers cap HTTP/1.1 connections at six per origin. ADK 2.0.0 supports
`StreamingMode.SSE` and `NONE`; `BIDI` throws.

## Decision

One SSE connection per browser session carries every thread's events. Each
event carries a `threadId`; commands from the client (start, follow up,
respond, cancel) are ordinary `POST`s whose effects arrive back on the stream.

The endpoint writes a priming frame (`retry:` plus a comment) before anything
else so intermediaries flush headers and `EventSource.onopen` fires.

## Alternatives

| | Why it lost |
|---|---|
| One SSE per thread | The seventh concurrent thread hangs silently, and only under concurrency |
| WebSocket | Hand-rolled reconnect, framing, heartbeat and backpressure for a client→server channel the design does not need; the hub stays single-writer with POST commands |
| Polling | No token-level streaming; latency floor of the interval |

## Consequences

- Demultiplexing, per-thread ordering and fairness become the server's
  problem ([ADR-0002](0002-two-counters-seq-and-offset.md)).
- Reconnect comes from the platform (`Last-Event-ID`), but `EventSource`
  cannot send headers, so the session id travels as a query parameter and
  identity needs a cookie or `fetch` streaming when it becomes real (L9).
- `EventSource` retry is not portable across engines; the client watches
  `readyState` and re-creates the connection itself, and the server accepts
  `?lastEventId=`. The browser suite runs in Chromium and Firefox for this.
