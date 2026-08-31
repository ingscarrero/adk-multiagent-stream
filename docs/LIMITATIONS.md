# Limitations and follow-ups

The canonical register of what this repo does **not** do. Every other document
links here rather than keeping its own partial list, so there is one place to
read and one place to update.

## The rule this file exists to enforce

> If a document describes a behaviour, that behaviour is implemented and tested.
> Anything partial, planned, or deliberately cut is recorded **here** instead.

That rule was added after an audit found four places — two docs and two source
comments — asserting that a `resync` mechanism worked end to end when only its
server half existed. A limitation you have written down is a design decision.
One your docs quietly claim you solved is a trap.

That gap (L1) and the counter that hid it (L13) have since been **fixed**; both
are kept below, struck through, because the reasoning is worth more than a
tidy list.

---

## Index

| | Limitation | Kind | Size |
|---|---|---|---|
| ~~[L1](#l1)~~ | ~~`resync` is emitted but never consumed~~ | **Fixed** | — |
| [L2](#l2) | No per-subscriber backpressure | **Correctness** | M |
| [L3](#l3) | Session hubs are never evicted | **Correctness** | S |
| [L4](#l4) | A thread cannot take a follow-up message | Scope | M |
| [L5](#l5) | `awaiting_input` is unreachable | Scope | M |
| [L6](#l6) | No responsive breakpoints or mobile tests | Scope | S |
| [L7](#l7) | **No message store**; everything is in memory | **Production** | M |
| [L8](#l8) | Single instance only | Production | L |
| [L9](#l9) | No authentication on the stream | Production | M |
| [L10](#l10) | The feed is not virtualised | Production | M |
| [L11](#l11) | Dropped events re-render for nothing | Performance | S |
| [L12](#l12) | Validation runs on every event | Performance | S |
| ~~[L13](#l13)~~ | ~~`stats.dropped` conflates two opposite meanings~~ | **Fixed** | — |
| [L14](#l14) | Counters are tracked but never surfaced | Observability | S |
| [L15](#l15) | ADK is deprecating the agents we compose with | Dependency | M |
| [L16](#l16) | A resynced feed can be mostly empty threads | UX | S |

[L7](#l7) and [L16](#l16) are the same problem seen twice — once from the
architecture, once from the screen. They are the pair to read first.

Test-coverage gaps are listed separately in [TESTING.md](TESTING.md#what-is-not-tested).

---

## Correctness

These can lose or misrepresent what the user sees. They are the ones to fix first.

### L1 — ~~`resync` is emitted but never consumed~~ · FIXED {#l1}

**Was** — the server emitted an `event: resync` frame on a replay-buffer
overrun and the client registered no listener for it. A client that reconnected
after the buffer had rolled past a thread's `thread.created` dropped that
thread's events forever: the thread was invisible for the rest of the session,
with no error and nothing in the UI to indicate anything was missing.

**Now** — the recovery path is closed end to end:

1. The server emits `resync` under the shared `SSE_RESYNC_EVENT_NAME`
   ([`sse.ts`](../apps/server/src/sse.ts)).
2. `GET /api/threads` returns a snapshot of the session's threads, each carrying
   its current `lastSeq` ([`app.ts`](../apps/server/src/app.ts),
   `ThreadRunner.summaries`).
3. The client tears the stream down, fetches the snapshot, dispatches a `resync`
   action, and reconnects at `from - 1` — the offset the notice named — so the
   server replays everything it still holds
   ([`useFeedStream.ts`](../apps/web/src/feed/useFeedStream.ts)).
4. The reducer rebuilds missing threads as shells marked `awaitingResume`, which
   accept the next event wherever its `seq` lands rather than seeking to a
   watermark ([`reducer.ts`](../apps/web/src/feed/reducer.ts), `applyResync`).

   Both of those clauses are load-bearing, and both were wrong first. The two
   paragraphs below are why.

**The snapshot is not a watermark, and treating it as one destroyed history.**
The obvious reading of `lastSeq` is "the server is at 47, so start there". That
shipped, and it was exactly wrong: immediately after the snapshot the server
replays its whole buffer, which for a recent thread contains *every one of its
events*. With `lastSeq` already at 47 they all failed the already-applied gate
and were discarded as redundant — the thread rendered empty and said its
messages were unavailable while its full transcript sat in the replay it had
just thrown away.

Threads are instead marked `awaitingResume`: the next event for them may skip
ahead, and whether it *actually* skipped is read from its `seq` when it arrives.
Arriving at seq 1 means nothing was lost; arriving above `lastSeq + 1` means a
prefix is gone. The client stops guessing what it missed and finds out.
`lastSeq` survives only as the hint that a rebuilt thread has history worth
warning about, until the replay settles the question.

**What is still lost.** Events live only in the bounded replay buffer, so a
rolled-out transcript is genuinely unrecoverable. A restored thread carries
`historyTruncated`, and the UI distinguishes the two cases: *"Earlier messages in
this thread were lost while reconnecting"* when some survived, and *"Messages for
this thread are no longer available"* when none did &mdash; the first phrasing is
misleading on a thread with nothing in it. Restoring transcripts would mean
persisting events, which is [L7](#l7).

**The notice's `from` field is a resume point, not decoration.** After handling a
`resync` the client reconnects at `from - 1`. Reconnecting with *no* resume point
seems more natural &mdash; "replay everything you have" &mdash; and loops
forever: the overrun test for a client with no offset is `oldestHeld > 1`, still
true the instant it returns, so the server sends another notice, the client
tears the stream down again, and live events never land. That shipped briefly
and showed up as new threads arriving empty and marked truncated. Both halves
are now tested: the client resumes at `from - 1`, and the server confirms that
offset produces no further notice while still replaying the full buffer.

**Two ways to be missing a prefix.** The first version of this fix handled only
a client *resuming* from a stale offset. A page reload sends no `lastEventId` at
all — it simply starts mid-stream — and took the other branch of `replayTo` with
no notice, so the thread was still invisible. `replayTo` now treats both the
same: resuming from below the oldest held offset, **or** connecting fresh to a
session whose start has already rolled out.

All three test layers passed while that branch was broken, because all three
exercised the resuming path. It was caught by driving a browser against a
four-event buffer. Worth remembering: layered tests prove each layer, not that
you enumerated the cases.

**Tested at three layers**, because the bug lived in the seam between them:
server emits the frame and serves the snapshot (`stream.test.ts`, with a
deliberately tiny buffer); the reducer rebuilds correctly (`reducer.test.ts`);
the hook actually dispatches on the frame (`useFeedStream.test.ts`, with a stub
`EventSource`). The middle two would both have passed while the feature stayed
broken — which is exactly how it stayed broken.

### L2 — No per-subscriber backpressure {#l2}

**Where** — [`sse.ts:107`](../apps/server/src/sse.ts), the `onEntry` callback
handed to `stream.open`, and the replay loop just below it.

The return value is discarded. Node returns `false` when the socket buffer is
full and then queues writes in memory without bound.

**Impact.** One slow or stalled consumer grows server memory for as long as it
stays connected. There is no ceiling and no eviction.

**Fix.** Check the return, pause on `'drain'`, and disconnect a subscriber that
falls beyond a threshold, sending a `resync` first. That instruction is now
honoured end to end ([L1](#l1)), so this is unblocked.

### L3 — Session hubs are never evicted {#l3}

**Where** — `HubRegistry.get` at [`sse.ts:204`](../apps/server/src/sse.ts).

Hubs are created on demand and only ever removed by `closeAll()` at shutdown.

**Impact.** Every distinct `sessionId` — every browser tab, ever — leaves a
permanent hub, and a permanent per-session log in the `eventStream` provider
holding up to `EVENT_RETENTION` events. Memory grows monotonically with unique
visitors. Retention is bounded per session; the number of sessions is not, which
is the wrong half to have bounded.

**Fix.** Record a last-activity timestamp per hub and sweep hubs that are idle
with no subscribers. The sweep must close the stream subscription too, not just
drop the hub — otherwise the listener stays registered against the log.

---

## Deliberate scope cuts

Not defects. Choices, with the reasoning recorded so it can be revisited.

### L4 — A thread cannot take a follow-up message {#l4}

Only `POST /api/threads` exists; one prompt starts one agent run and the thread
is then closed to input. There is no way to reply within a thread.

**Why it is a cut and not an oversight.** The exercise this repo models is
concurrent *threads*, and every ordering property it demonstrates is per-thread
and holds regardless of turn count.

**What already exists.** Each thread owns its own ADK session
([`thread-runner.ts:228`](../apps/server/src/thread-runner.ts)), and ADK
accumulates conversation history in it, so the agent side is ready.

**Fix.** `POST /api/threads/:id/messages` reusing that session, a
`message.user` event type in the protocol, timeline placement in the reducer,
and a per-thread composer. The one genuinely interesting part is the status
machine, which needs a terminal → `running` re-entry it does not currently allow.

### L5 — `awaiting_input` is unreachable {#l5}

The status is defined in the machine and handled in the adapter, but no tool
declares `requireConfirmation`, so no run ever enters it.

**Fix.** Give one tool `requireConfirmation`, surface the
`adk_request_confirmation` interrupt, and add an approve/deny control. No
protocol change needed — the state was modelled ahead of the feature on purpose.

### L6 — No responsive breakpoints or mobile tests {#l6}

`styles.css` has no width media queries, and `playwright.config.ts` defines no
mobile project. The layout holds at desktop widths by luck of the flex/grid
defaults, not by design.

---

## Production readiness

Fine for a boilerplate. Each would be a blocker for a real deployment.

### L7 — There is no message store, and everything is in memory {#l7}

Two problems wear one number, and the second is the interesting one.

**Nothing survives a restart.** Sessions, thread records and the event log all
live in process. Each now has a port — `PROVIDER_SESSIONS` selects the session
store and `ThreadRunner` takes a `BaseSessionService` rather than constructing
one; `PROVIDER_EVENTSTREAM` selects the log — so each real adapter is a config
change rather than a refactor ([PROVIDERS.md](PROVIDERS.md)). None of the real
adapters is written yet. The thread registry is the one store with no seam at
all.

**More importantly, the event log is doing a job it is the wrong shape for.**
There is nowhere else agent messages exist, so the retention window is also the
lifetime of the conversation. Every symptom of that is user-visible: a snapshot
that returns identity and no messages, *"Messages for this thread are no longer
available"*, and a long session degrading into unreadable history
([L16](#l16)).

A log answers *what happened next* over a window. A transcript is *state read by
key, kept indefinitely*. Persisting the log — a Redis adapter — does not fix
this; it makes the same wrong-shaped store durable and multi-instance.
`docs/ARCHITECTURE.md` has the full argument and the division of labour.

**Fix.** A `messageStore` port written at settle points only — `message.complete`,
tool calls and results, status transitions — never `message.delta`, which is a
transport artefact worth nothing once the message closes. That is roughly five
writes per thread instead of twenty-three. The store becomes truth and the
stream is demoted to liveness; `resync` keeps its whole shape and starts
returning messages instead of an apology. This closes [L16](#l16) outright and
is the next thing to build.

### L8 — Single instance only {#l8}

One process owns a session's log and its subscribers. A reconnect routed to a
different instance finds an empty log and gets no replay, so this fails
*silently* rather than loudly.

The seam exists — `PROVIDER_EVENTSTREAM` — and a Redis Streams adapter behind it
is what makes the deployment horizontal; sticky sessions are the alternative
that avoids the problem rather than solving it. Only the memory adapter is
written. The planned adapter, and the one genuine obstacle in it (Redis stream
ids are not integers, and `from - 1` arithmetic is load-bearing), are in
[visual/event-stream.html](visual/event-stream.html).

### L9 — No authentication on the stream {#l9}

`sessionId` is generated by the client and trusted by the server. Anyone who
guesses one reads that feed.

There is now a port: `PROVIDER_IDENTITY` selects the adapter and every route
resolves the caller through it rather than reading a header directly, so a JWT
adapter drops in without touching the routes. It is not written yet, and it will
need a client change too — the browser has to obtain and send a token, and
`EventSource` cannot set headers.

### L10 — The feed is not virtualised {#l10}

Every thread and every message is in the DOM. Fine at ten threads; not at a
thousand.

---

## Performance

Both are deliberate trades, recorded so the trade stays visible.

### L11 — Dropped events re-render for nothing {#l11}

**Where** — the three drop sites in
[`reducer.ts`](../apps/web/src/feed/reducer.ts) (lines 395, 411 and 442), all of
which `return { ...state, stats }`.

A new state object means `useReducer` never bails out, so a reconnect replaying
300 duplicates costs 300 renders with no visual change.

**Fix.** Return the identical `state` reference on a redundant drop. The only
thing preventing it is the counter increment, which could move to a ref.

### L12 — Validation runs on every event {#l12}

**Where** — [`thread-runner.ts:184`](../apps/server/src/thread-runner.ts).

Every outgoing event is parsed through zod, including every token delta. Chosen
deliberately: a protocol mistake fails in the server's own tests instead of
vanishing in the browser. If profiling ever justified it, validating in
development only would be the change.

---

## Observability

### L13 — ~~`stats.dropped` conflates two opposite meanings~~ · FIXED {#l13}

**Was** — redundant drops (gate 2, and gate 3's inner check) and lossy drops
(gate 1) both incremented one `stats.dropped`, so the number could not
distinguish a healthy reconnect from data loss.

**Now** — `stats` carries `droppedRedundant` and `droppedLossy` separately, plus
a `resyncs` count. `totalDropped(stats)` sums them for display where the
distinction does not matter. Each of the three drop sites in `reducer.ts` is
labelled `REDUNDANT` or `LOSSY` at the point of the increment.

This mattered more than its size suggests: **`droppedLossy` is the signal that
[L1](#l1) was firing.** Buried in a combined counter alongside the replay drops
that follow every reconnect, the one number that meant "the feed is missing
something" was indistinguishable from noise.

### L14 — Counters are tracked but never surfaced {#l14}

`FeedState.stats` carries four counters — `applied`, `droppedRedundant`,
`droppedLossy`, `resyncs` — and only `applied` is consumed, as the sticky-scroll
trigger in [`App.tsx:60`](../apps/web/src/App.tsx). Since [L13](#l13), the
values are meaningful, and `?debug` now reveals all four in the header —
which is what makes recovery observable while testing by hand
(see [TESTING.md](TESTING.md)). They remain hidden by default and there is no
alerting: `droppedLossy > 0` is the one number worth wiring to something.

---

## User experience

### L16 — A resynced feed can be mostly empty threads {#l16}

**Where** — `ThreadRunner.summaries` returns every thread the session has ever
had, and the server never forgets one ([L3](#l3)). The replay window that limits what
can be restored is now the `eventStream` provider ([PROVIDERS.md](PROVIDERS.md)),
so retention is `EVENT_RETENTION` rather than a constant inside `SessionHub` —
but a shared store still has to be written before any of it survives a restart.

After a replay-buffer overrun, a reload rebuilds *all* of them, but only the
tail of the session has content left to restore. The buffer holds events, not
threads, and a thread costs `5 + 4T + ceil(W / 3)` events — five fixed, four per
tool round trip, one delta per three words. That is 10 for a no-tool answer, 23
for the order-tracking prompt, 42 for the research pipeline. The readable window
is therefore roughly 12 to 50 threads at the default 500, and one or two on the
small-buffer `dev:recovery` server.

Everything older comes back as an empty card. The window slides as new threads
arrive, so a long-running session tends toward a feed that is mostly unreadable
history with a few live threads at the end. They render as a quiet italic line
rather than a card with a warning bar, and the wording says the messages are
gone rather than implying some are missing, but the noise is real and it grows.

**Why they are restored at all.** Dropping them silently is exactly what
[L1](#l1) was about, and an active thread *must* be restored or its future
events never land. The cost falls entirely on finished threads whose transcript
is unrecoverable.

**Untested against a real model.** The per-thread cost above is measured in
scripted mode. With `MODEL_MODE=gemini` the delta count is whatever the API
chunks to, so the readable window could be several times smaller and the
`EVENT_RETENTION: 500` default may be badly sized. Measuring it needs an API
key and has not been done &mdash; `lastSeq` in the snapshot is the event count
per thread, so it is a one-liner once someone has one. See
[TESTING.md](TESTING.md).

**Fix.** Three options, roughly in order of effort:

1. **Bound the snapshot** — return every non-terminal thread plus the N most
   recent terminal ones, so the feed cannot outgrow what is restorable.
2. **Collapse the ghosts** — keep them all, but behind a "23 earlier threads"
   disclosure so they cost one line rather than twenty-three cards.
3. **Persist events** — then nothing is unreadable and the whole limitation
   disappears, at the cost of a store. That is [L7](#l7).

None is built; the honest wording and the quiet rendering are.

---

## Dependency direction

### L15 — ADK is deprecating the agents we compose with {#l15}

`@google/adk` v2.0.0 logs that `SequentialAgent` and `ParallelAgent` are
deprecated in favour of the newer `Workflow` graph API — while the same warning
states that `Workflow` cannot yet be an `LlmAgent` sub-agent.

They are kept deliberately: they still work, and they are what ADK's own guides
teach, which keeps this repo legible to anyone arriving from those docs.

**Fix.** `buildResearch` in `packages/agents/src/agents.ts` is the only caller.
The feed layer needs no change, because `Workflow` emits the same `Event` shape
with `nodeInfo` added. The properties that must survive the migration are named
in `packages/agents/src/agents.test.ts`: the parallel branches must still
interleave, and the synthesizer must still run strictly last.
