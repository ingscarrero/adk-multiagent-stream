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

Six entries have since been **fixed** — L1 and the counter that hid it (L13),
both correctness items (L2, L3), and both multi-turn scope cuts (L4, L5). All
six are kept below, struck through, because the reasoning is worth more than a
tidy list.

**Correctness is empty, and the scope cuts that were about conversation shape
are closed.** What remains is production readiness, performance, two smaller
scope cuts, one observability gap and two UX ones.

---

## Index

| | Limitation | Kind | Size |
|---|---|---|---|
| ~~[L1](#l1)~~ | ~~`resync` is emitted but never consumed~~ | **Fixed** | — |
| ~~[L2](#l2)~~ | ~~No per-subscriber backpressure~~ | **Fixed** | — |
| ~~[L3](#l3)~~ | ~~Session hubs are never evicted~~ | **Fixed** | — |
| ~~[L4](#l4)~~ | ~~A thread cannot take a follow-up message~~ | **Fixed** | — |
| ~~[L5](#l5)~~ | ~~`awaiting_input` is unreachable~~ | **Fixed** | — |
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
| [L17](#l17) | Stop cannot be clicked by hand in scripted mode | UX | S |

[L7](#l7) and [L16](#l16) are the same problem seen twice — once from the
architecture, once from the screen. They are the pair to read first.

Test-coverage gaps are listed separately in [TESTING.md](TESTING.md#what-is-not-tested).

---

## Correctness

These could lose or misrepresent what the user sees, which is why they were
first. All three are now closed.

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

### L2 — ~~No per-subscriber backpressure~~ · FIXED {#l2}

**Was** — every `res.write` discarded its return value. Node returns `false`
when the kernel socket buffer is full and then queues the rest in process
memory with no ceiling, so one consumer that stopped reading — a suspended
laptop, a paused debugger, a phone that lost signal without closing the socket
— grew server memory for as long as it stayed connected.

**Now** — writes go through `SessionHub.writeTo`, which disconnects a
subscriber whose queue passes `SSE_MAX_BUFFERED_BYTES` (default 1 MiB).
`res.end()` makes Express emit `close`, which runs the same detach the ordinary
path uses, so the subscription is released through one code path rather than
two that can drift.

**The ceiling is on `writableLength`, not on the return value.** `write`
returning `false` is normal: it means the socket buffer filled and Node took
over queuing, which a healthy consumer drains in milliseconds. Treating that as
the fault signal would disconnect clients on an ordinary burst. What is
pathological is a queue that only grows, and `writableLength` is that queue.

**No `resync` is sent before disconnecting**, which is where this departs from
the fix sketched here originally. It would be futile and unnecessary — futile
because the frame joins the very queue being bounded, and unnecessary because
the reconnect handshake already computes the answer. SSE frames are
`\n\n`-delimited, so a half-written frame is discarded by the parser and the
browser's `Last-Event-ID` is the last *complete* frame. Reconnecting from there
either replays cleanly, if those offsets are still retained, or trips the
overrun notice if they are not. Both outcomes are correct without help.

**Tested** in `sse.test.ts` against a fake `Response`, because the assertion is
about Node's write queue and driving a real socket into sustained backpressure
means writing megabytes and trusting every machine's kernel buffer to behave
alike. A draining subscriber survives 200 events; a stalled one is disconnected
with its queue bounded near the ceiling; later events do not write to an ended
response; and evicting one subscriber leaves its neighbours streaming. Removing
the ceiling turns three of them red.

### L3 — ~~Session hubs are never evicted~~ · FIXED {#l3}

**Was** — hubs were created on demand and removed only by `closeAll()` at
shutdown. Every distinct `sessionId` — every browser tab, ever — left a
permanent hub and a permanent per-session log holding up to `EVENT_RETENTION`
events. Retention bounded what was kept *per session*; nothing bounded the
number of sessions, which is the wrong half to have bounded.

**Now** — `HubRegistry` sweeps on an interval
(`SESSION_SWEEP_INTERVAL_MS`, default 60s), dropping every hub that has **no
subscribers** and has been idle past `SESSION_IDLE_TTL_MS` (default 15
minutes).

**Sweeping the hub was not enough, and the fix originally written here would
have missed it.** The hub is a `Set` and a timer handle; the events are the
memory, and they live in the `eventStream` provider keyed by session. So the
port gained `drop(sessionId)` — `sessions.delete` in the memory adapter, `DEL`
in Redis, a documented no-op in Kafka, which has no per-key delete and lets
topic retention do the work. It is in the contract suite, so every future
adapter has to answer for it.

Dropping also resets the session's offset counter, which matters more than it
looks: a session id that comes back would otherwise find `oldestOffset` sitting
above its position and resync on every connect.

**Both conditions are required.** `publish` counts as activity, so a thread
still running with nobody watching keeps its session alive — closing a tab
mid-run does not throw the run away. And because every subscriber's detach
closes its subscription, a hub at zero subscribers has none open, which is
exactly the guarantee `drop` asks of its caller.

**Tested** in `sse.test.ts`: a sweep drops the hub *and* the log, spares a hub
with a live subscriber, spares an idle hub whose run is still publishing,
restarts offsets at 1 for a returning session id, and touches only what is
stale. Reverting to the hub-only sweep — the naive fix — turns two of them red.

---

## Deliberate scope cuts

Not defects. Choices, with the reasoning recorded so it can be revisited.

### L4 — ~~A thread cannot take a follow-up message~~ · FIXED {#l4}

**Was** — only `POST /api/threads` existed. One prompt started one run and the
thread was then closed to input.

**Now** — `POST /api/threads/:id/messages` runs again against the thread's
existing ADK session. That is the whole feature: ADK accumulates the
conversation there, so the agent sees earlier turns without anything being
re-sent. Everything else is bookkeeping around it — a `message.user` event so
the follow-up lands in the transcript in the right place, timeline placement in
the reducer, and a per-thread composer that appears only once a turn has
finished.

**The status machine was the interesting part, as predicted.** `complete` and
`cancelled` gained exactly one outgoing edge, back to `running`. That forced a
distinction the code had been eliding: **terminal ends a *turn*, not a
*thread*.** A thread is a conversation. So `isTerminal` and the new
`canAcceptFollowUp` now disagree on exactly one status — `error`, which stays
closed, because a failed run left an unknown amount of work half applied and
continuing on top of it is worse than starting again.

The 64-pair status test caught the change immediately, which is what it is for.
Its "no transition out of a terminal status" assertion had to weaken; it is now
the strongest form still true — *a terminal status reaches nothing except
`running`, and only when it can accept a follow-up* — plus a separate assertion
that an errored thread never re-opens.

**The scripted follow-up is deliberately tool-free.** `completedToolRounds`
counts tool responses across the whole session, so a follow-up branch sharing a
tool name with the turn before it would start at turn 1 and skip its own first
step — the same hazard the transfer comment in `scripted-llm.ts` describes. It
is also the honest scripting: answering "when will it arrive" from what the
previous turn established is exactly what history is for, and the browser test
asserts the answer names an order id the follow-up never mentioned.

### L5 — ~~`awaiting_input` is unreachable~~ · FIXED {#l5}

**Was** — the status was in the machine and handled in the adapter, but no tool
declared `requireConfirmation`, so no run ever entered it.

**Now** — `requestRefund` gates on approval, ADK pauses instead of running it,
and the thread sits in `awaiting_input` until someone answers through
`POST /api/threads/:id/respond`.

**A predicate, not a flag.** `requireConfirmation` takes
`(args) => amount > 50`, because that is the honest shape of the requirement:
nobody wants to approve a $4 refund by hand and everybody wants to approve a
$400 one. A boolean would have demonstrated the mechanism and hidden the reason
ADK's API takes a function.

**The protocol did need a change after all**, and the note above was wrong to
say otherwise. `awaiting_input` tells a client to stop showing a spinner; it
does not say *what* is being asked or what to send back. Hence
`thread.input_required`, carrying ADK's interrupt id, the tool name, and — the
part that matters — **the arguments the call would run with**. ADK's own prompt
names the tool and stops there, and "approve `requestRefund`" is the same
sentence for $4 and $400. Approving an action whose parameters you cannot see
is a rubber stamp.

**Three things this surfaced that were not on the list:**

1. `awaiting_tool -> awaiting_input` was not a legal transition. ADK emits the
   tool call first and the interrupt immediately after, so the thread passes
   through one on the way to the other. Found by `assertTransition` throwing.
2. The terminal guarantee needed restating. A paused run is not finished, and
   closing it out as `complete` would be both a lie and unanswerable — so the
   guarantee is now *every turn ends in a terminal status, or in
   `awaiting_input` with a request the client can answer.*
3. The scripted model could not tell approval from denial. Both reach the same
   script position, so a denied refund reported itself as approved while every
   other assertion passed. Fixed with `rejectedText`: the one place a script
   reads a tool *result* rather than counting rounds. Deliberately the narrowest
   version of that — was the last result an error, or not — because anything
   richer is a rules engine pretending to be a language model.

**Denial is a decision, not a dropped call.** ADK returns the call refused
(`{ error: 'This tool call is rejected.' }`) rather than skipping it, so the
tool never executes and the turn still terminates.

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
for the order-tracking prompt, 40 for the research pipeline. The readable window
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

### L17 — Stop cannot be clicked by hand in scripted mode {#l17}

**Where** — `SCRIPTED_CHUNK_DELAY_MS` (default 25) in
[`scripted-llm.ts`](../packages/agents/src/scripted-llm.ts) and
`TOOL_LATENCY_MS` (default 150) in
[`tools.ts`](../packages/agents/src/tools.ts).

The Stop control renders only while a thread's status is non-terminal
([`ThreadCard.tsx`](../apps/web/src/feed/ThreadCard.tsx), `const active =
!isTerminal(thread.status)`), which is correct: offering to cancel something
already finished is worse than not offering it.

At the default pacing that window is **465 ms** for the order-tracking prompt
and **657 ms** for the research pipeline, measured off the wire. A person cannot
notice a control appear, decide to use it and reach it in that time. The feature
is fully built, wired and tested, and reads as missing to anyone evaluating the
app by hand.

**Why it is not a defect in the feature.** With `MODEL_MODE=gemini` a thread
runs for seconds and Stop is comfortably reachable. The 465 ms is an artefact of
the scripted model being fast on purpose — the same property that makes the test
suite deterministic.

**Why it is still a real problem.** The first thing anyone does with this repo
is `pnpm dev`, send a prompt, and look at what happens. Cancellation is one of
the more interesting things it does, and at the default it is invisible. A
capability nobody can observe is indistinguishable from one that does not exist.

The same root cause already bit the browser suite: the cancellation specs could
not reliably click Stop either, which is why `playwright.config.ts` pins
`SCRIPTED_CHUNK_DELAY_MS: '60'` for its web servers. That fix was applied to the
tests and not to the human.

**Fixed, as a second way to run it rather than a new default.**

```bash
pnpm dev:demo    # SCRIPTED_CHUNK_DELAY_MS=200 TOOL_LATENCY_MS=400
```

The window becomes **2.0 s** for the router and **4.2 s** for the research
pipeline, both verified by clicking Stop in a browser and watching the thread
settle to `cancelled` with its messages cut mid-sentence.

The shipped default is deliberately unchanged. Raising it would slow the first
thing every reader sees in order to fix a problem that only appears when someone
evaluates by hand, and CI would then be running different pacing from `pnpm dev`
for no benefit. Two named ways to run it is the smaller lie: `dev` is what the
tests exercise, `dev:demo` is what a person watches.

Both knobs remain settable directly, and are documented in
[`.env.example`](../.env.example) and the README config table.

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
