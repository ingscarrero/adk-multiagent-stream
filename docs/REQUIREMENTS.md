# Requirements

What the system is required to do, and how well. Each functional requirement
is traced to the code that implements it and the test that proves it, so the
list can be checked rather than trusted. Non-functional requirements
consolidate what [LIMITATIONS.md](LIMITATIONS.md) records as gaps and add the
sections that document did not cover — security and cost.

Conventions: **FR** functional, **NFR** non-functional. "Status" is one of
*met*, *partial* (with the limitation id), or *not met*.

---

## Functional requirements

### Threads and streaming

| Id | Requirement | Implemented in | Proven by | Status |
|---|---|---|---|---|
| FR-1 | A user can start a thread by sending a prompt to a named agent. The request is accepted (`202`) before any work completes. | `POST /api/threads` — `apps/server/src/app.ts`; `ThreadRunner.start` | `stream.test.ts`, `e2e/specs/streaming.spec.ts` | met |
| FR-2 | Every event for every thread in a session arrives on **one** SSE connection, each event carrying its `threadId`. | `GET /api/stream` — `app.ts`; `SessionHub` in `sse.ts` | `stream.test.ts` ("three threads, one connection") | met |
| FR-3 | Several threads may run concurrently; each thread's events are delivered in order, and one thread's pace does not block another's. | `ThreadRunner` (detached runs), per-thread `seq` | `stream.test.ts`, `e2e/specs/concurrency.spec.ts` | met |
| FR-4 | Events within a thread carry a monotonic `seq` starting at 1; the client reassembles in `seq` order regardless of arrival order, drops duplicates, and buffers across gaps. | `packages/protocol/src/events.ts`; `apps/web/src/feed/reducer.ts` | `reducer.test.ts`, `events.test.ts` | met |
| FR-5 | Model text streams as `message.delta` events and settles with a `message.complete` carrying the full authoritative text. | `adk-adapter.ts`; `MessageBubble.tsx` | `adk-adapter.test.ts`, `stream.test.ts` ("deltas reconstruct the final text") | met |
| FR-6 | Tool calls are shown inline with their arguments, and their results once returned, correlated by `callId`. | `adk-adapter.ts`; `ToolStep.tsx` | `adk-adapter.test.ts`, `ToolStep.test.tsx`, `ThreadCard.test.tsx` | met |
| FR-7 | Each thread has a visible status that follows the lifecycle in [§4 of the contract](STREAMING-CONTRACT.md#4-thread-status). Illegal transitions throw on the server and are ignored on the client. | `packages/protocol/src/status.ts`; `StatusChip.tsx` | `status.test.ts` (all 64 pairs), `StatusChip.test.tsx` | met |
| FR-8 | Every turn ends in a terminal status (`complete`, `error`, `cancelled`) or in `awaiting_input` with a request the client can answer — including when the model errors, ADK throws, or the client cancels. Any open message is closed. | `ThreadRunner` `finally` block — `thread-runner.ts` | `stream.test.ts` (error, cancel, throw paths) | met |
| FR-9 | Errors are reported with a reason (`thread.error`) **before** the terminal status. | `adk-adapter.ts` | `adk-adapter.test.ts` | met |

### Agent behaviour

| Id | Requirement | Implemented in | Proven by | Status |
|---|---|---|---|---|
| FR-10 | A router agent classifies the prompt and transfers to a specialist; the thread's `author` changes mid-stream without a new thread being created. | `packages/agents/src/agents.ts` (`buildRouter`) | `agents.test.ts`, `adk-adapter.test.ts` | met |
| FR-11 | A research pipeline fans out to two agents in parallel and synthesises their findings strictly afterwards; the interleaved output is attributed per author. | `agents.ts` (`buildResearch`) | `agents.test.ts` ("interleaves", "synthesizer strictly after") | met |
| FR-12 | Agents can call tools with zod-validated arguments: order lookup, shipping status, knowledge search, refund. | `packages/agents/src/tools.ts` | `tools.test.ts`, `agents.test.ts` | met |
| FR-13 | The model is deterministic by default (`MODEL_MODE=scripted`), so every test and eval runs offline; a real Gemini model is selectable with a key. | `packages/agents/src/model.ts`, `scripted-llm.ts` | `model.test.ts`, `scripted-llm.test.ts` | met |
| FR-14 | Agent behaviour is regression-tested by evals scoring tool trajectory and response match against an evalset, both as a CLI and inside `pnpm test`. | `packages/eval/`, `evalsets/support.evalset.json` | `eval.test.ts`, `metrics.test.ts`, `pnpm eval` | met |

### Conversation

| Id | Requirement | Implemented in | Proven by | Status |
|---|---|---|---|---|
| FR-15 | A user can cancel a running thread; it settles to `cancelled` with open messages closed, and other threads are unaffected. `202` if delivered, `409` if already finished, `404` if unknown. | `POST /api/threads/:id/cancel`; `AbortController` in `thread-runner.ts` | `stream.test.ts`, `e2e/specs/streaming.spec.ts` | met — reachable by hand only under `pnpm dev:demo` ([L17](LIMITATIONS.md#l17)) |
| FR-16 | A user can send a follow-up into a `complete` or `cancelled` thread; the agent answers from the accumulated session history. `409` if the thread is in any other state. | `POST /api/threads/:id/messages`; `ThreadRunner.followUp`; `ThreadComposer.tsx` | `stream.test.ts`, `ThreadComposer.test.tsx`, `e2e/specs/conversation.spec.ts` | met |
| FR-17 | A tool call that spends money above a threshold pauses the thread in `awaiting_input`, shows the exact arguments, and runs only after explicit approval. Denial is recorded and the turn still terminates. | `requestRefund.requireConfirmation` — `tools.ts`; `POST /api/threads/:id/respond`; `ApprovalPrompt.tsx` | `tools.test.ts`, `ApprovalPrompt.test.tsx`, `stream.test.ts`, `conversation.spec.ts` | met |
| FR-18 | An approval must name the pending `requestId`; answering a different or stale request is refused (`409`). | `app.ts`, `ThreadRunner.respond` | `stream.test.ts` | met |

### Recovery

| Id | Requirement | Implemented in | Proven by | Status |
|---|---|---|---|---|
| FR-19 | A client that reconnects with `Last-Event-ID` (or `?lastEventId=`) receives every retained event after that offset, with no gap and no duplicate applied. | `SessionHub.subscribe`, `EventStream.open` | `stream.test.ts`, `eventstream.test.ts` (contract), `e2e/specs/resilience.spec.ts` | met |
| FR-20 | When the resume point has rolled out of the retained window, the server says so (`resync`), the client rebuilds from `GET /api/threads` and reconnects at the offset named — and never loops. | `sse.ts`, `useFeedStream.ts`, `reducer.ts` (`applyResync`) | `stream.test.ts`, `useFeedStream.test.ts`, `reducer.test.ts`, `e2e/specs/recovery.spec.ts` | met |
| FR-21 | A thread whose transcript was lost says so in the UI, distinguishing "earlier messages lost" from "nothing available". | `ThreadCard.tsx` (`historyTruncated`) | `ThreadCard.test.tsx` | met — content is not restorable ([L7](LIMITATIONS.md#l7), [L16](LIMITATIONS.md#l16)) |
| FR-22 | The client reconnects on its own in browsers whose `EventSource` gives up (`CLOSED`). | `useFeedStream.ts` | Playwright Firefox project | met |

### Operability

| Id | Requirement | Implemented in | Proven by | Status |
|---|---|---|---|---|
| FR-23 | `GET /api/health` reports liveness, the model mode, the available agents, and which capability is emulated versus real. | `app.ts`, `packages/providers/src/catalog.ts` | `stream.test.ts`, `providers.test.ts` | met |
| FR-24 | The UI exposes its recovery counters (`applied`, `buffered`, `droppedRedundant`, `droppedLossy`, `resyncs`) behind `?debug`. | `App.tsx` | `App.test.tsx`, `recovery.spec.ts` | met — hidden by default, no alerting ([L14](LIMITATIONS.md#l14)) |
| FR-25 | The feed follows new content while the reader is at the bottom and stops the moment they scroll up, offering a way back. | `useStickyScroll.ts`, `App.tsx` | `useStickyScroll.test.ts` | met |
| FR-26 | The UI offers the agents the server reports, with per-agent prompt suggestions, and falls back to a built-in list if the health check fails. | `Composer.tsx`, `App.tsx` | `Composer.test.tsx`, `App.test.tsx` | met |

---

## Non-functional requirements

### Performance

| Id | Requirement | Current state |
|---|---|---|
| NFR-P1 | First byte on the stream immediately on connect, so `EventSource.onopen` fires through any proxy. | met — the priming `retry:` + comment frame (`sse.ts`), pinned by test |
| NFR-P2 | Reducer work per event is synchronous and sub-millisecond; no ordering logic runs in the browser beyond the reducer. | met — pure function, tested with array literals |
| NFR-P3 | Per-thread event cost is bounded and known: `5 + 4T + ⌈W/3⌉` events per turn in scripted mode (10–40 in practice). | met for scripted; **unmeasured with Gemini** ([TESTING.md](TESTING.md#what-changes-with-real-gemini)) |
| NFR-P4 | Memory per session is bounded by `EVENT_RETENTION` (500 events) and per subscriber by `SSE_MAX_BUFFERED_BYTES` (1 MiB); sessions are swept after `SESSION_IDLE_TTL_MS`. | met ([L2](LIMITATIONS.md#l2), [L3](LIMITATIONS.md#l3) closed) |
| NFR-P5 | Redundant (replayed) events should not trigger a re-render. | **not met** — a dropped duplicate still returns a new state object ([L11](LIMITATIONS.md#l11)) |
| NFR-P6 | Outgoing events are schema-validated; the cost is accepted in exchange for failing loudly in the server's own tests. | met by design ([L12](LIMITATIONS.md#l12)) |
| NFR-P7 | The feed renders efficiently at scale (hundreds of threads). | **not met** — no virtualisation ([L10](LIMITATIONS.md#l10)) |

### Reliability

| Id | Requirement | Current state |
|---|---|---|
| NFR-R1 | No turn is left in a non-terminal state without a way to resume it (FR-8). | met — `finally` in `thread-runner.ts` |
| NFR-R2 | A stalled consumer cannot grow server memory without bound. | met — write ceiling then disconnect ([L2](LIMITATIONS.md#l2)) |
| NFR-R3 | Idle connections survive proxies: a heartbeat every `SSE_HEARTBEAT_MS` (15 s). | met |
| NFR-R4 | Reconnect is safe: replay within the window is exact; outside it the client is told and recovers without looping. | met (FR-19, FR-20) |
| NFR-R5 | A runaway agent loop is capped. | met — `maxLlmCalls: 20` per run |
| NFR-R6 | State survives a process restart. | **not met** — sessions, threads and the log are in memory ([L7](LIMITATIONS.md#l7)) |
| NFR-R7 | The service runs as more than one instance. | **not met** — one process owns a session's log and subscribers ([L8](LIMITATIONS.md#l8)); the seam exists (`PROVIDER_EVENTSTREAM`) |
| NFR-R8 | The test suite is deterministic: no sleeps, no live model, no flaky timing. | met — `ScriptedLlm` everywhere; zero `waitForTimeout` in Playwright |

### Observability

| Id | Requirement | Current state |
|---|---|---|
| NFR-O1 | Which adapter backs each capability is observable at runtime. | met — `GET /api/health` |
| NFR-O2 | Data loss on the client is distinguishable from healthy replay drops. | met — `droppedLossy` vs `droppedRedundant` ([L13](LIMITATIONS.md#l13)) |
| NFR-O3 | Those counters are surfaced and alertable. | **partial** — visible with `?debug`, nothing wired ([L14](LIMITATIONS.md#l14)) |
| NFR-O4 | Requests, runs and tool calls are traced. | **not met** — no OpenTelemetry; ADK ships a GCP exporter that is not wired ([PROVIDERS.md](PROVIDERS.md#not-emulated--simply-absent)) |
| NFR-O5 | A red CI run is diagnosable without a rerun. | met — Playwright HTML report and coverage report uploaded as artifacts |

### Security

The authentication boundary is the load-bearing gap; everything else here
describes what the code does enforce so the boundary is precise.

| Id | Requirement | Current state |
|---|---|---|
| NFR-S1 | **Auth boundary.** A caller may only read and act on its own session's threads. | **partial** — the session id is client-supplied and trusted (`PROVIDER_IDENTITY=trusted-header`); ownership *is* checked (`existing.sessionId !== sessionId → 404`), but the id is guessable ([L9](LIMITATIONS.md#l9)). A JWT adapter is a port away; it also needs a client change because `EventSource` cannot set headers — a cookie or `fetch` streaming |
| NFR-S2 | **Input handling.** Every request body is validated before use; oversized bodies are rejected. | met — zod schemas in `packages/protocol`, `express.json({ limit: '64kb' })`; unknown agent ids and thread ids return `400`/`404` |
| NFR-S3 | Prompt text reaches the model only as a user message; tool arguments come from the model and are validated against each tool's zod schema before `execute` runs. | met — `FunctionTool.parameters` |
| NFR-S4 | Actions with real-world side effects require human approval above a threshold, with the arguments visible; a stale approval cannot authorise a different request. | met (FR-17, FR-18) — ADK fails closed on its side too |
| NFR-S5 | **Provider keys** are never in source, never logged, never needed by CI. | met — `.env` gitignored, `.env.example` blank, CI runs `MODEL_MODE=scripted` with no secrets; `/api/health` reports modes, not values |
| NFR-S6 | **CORS** is restricted to the configured origin, without credentials. | met — `CORS_ORIGIN` (default `http://localhost:5173`), `credentials: false` |
| NFR-S7 | Rate limiting and per-caller quotas. | **not met** — none; the memory ceilings bound cost per connection, not per caller |
| NFR-S8 | Dependencies are pinned and auditable. | met — exact versions, `pnpm-lock.yaml`, `--frozen-lockfile` in CI |
| NFR-S9 | Vulnerability reporting has a private channel. | met — [SECURITY.md](../SECURITY.md) |

### Cost

| Id | Requirement | Current state |
|---|---|---|
| NFR-C1 | Development, tests, evals and CI incur **zero** model cost. | met — `MODEL_MODE=scripted` default; the real model is opt-in |
| NFR-C2 | With a real model, cost per thread is bounded. | met in principle — at most `maxLlmCalls` (20) model calls per run; **unmeasured** in tokens, because the delta and tool counts are the model's choice |
| NFR-C3 | Knowledge retrieval and embeddings incur no external cost by default. | met — keyword matching over fixtures; a vector adapter is opt-in |
| NFR-C4 | Compute footprint is small enough for one small container. | met — one Node process, in-memory state, no build step between packages |
| NFR-C5 | CI minutes are bounded. | met — three jobs, browsers installed per matrix leg only, `concurrency` cancels superseded runs |

The cost envelope with real providers is estimated in
[SYSTEM_DESIGN.md — Cost envelope](SYSTEM_DESIGN.md#cost-envelope).

### Accessibility (web UI)

| Id | Requirement | Current state |
|---|---|---|
| NFR-A1 | No WCAG 2.1 A/AA violations in the empty, streaming, complete and errored states, in both light and dark palettes. | met — `@axe-core/playwright` scans in `e2e/specs/a11y.spec.ts`; two contrast defects were found and fixed this way |
| NFR-A2 | Status changes are announced once, per thread, politely. | met — one `aria-live="polite"` region per thread wrapping the status line; the chip itself is `aria-hidden` |
| NFR-A3 | Streaming prose is **not** a live region, so a screen reader is not made to re-read a message on every token. | met — asserted in `a11y.spec.ts` and `ThreadCard.test.tsx` |
| NFR-A4 | A blocking human decision is announced assertively. | met — `ApprovalPrompt` is `role="alert"` |
| NFR-A5 | Every control is reachable and operable from the keyboard; tool payloads use native `<details>`. | met — `a11y.spec.ts` keyboard assertions |
| NFR-A6 | Each thread and the feed have accessible names; the feed is `role="log"`. | met — `ThreadCard.test.tsx`, `App.test.tsx` |
| NFR-A7 | Responsive layout and mobile viewports. | **not met** — desktop widths only ([L6](LIMITATIONS.md#l6)) |

### Maintainability and portability

| Id | Requirement | Current state |
|---|---|---|
| NFR-M1 | The client and the wire contract have no dependency on the agent framework. | met — `apps/web` and `packages/protocol` import nothing from `@google/adk` |
| NFR-M2 | Infrastructure is reached through ports with emulated defaults; swapping an adapter changes no calling code. | met for sessions, knowledge, identity, eventStream; **absent** for the message store ([L7](LIMITATIONS.md#l7)) |
| NFR-M3 | Every known gap has a stable id, a cause, a blast radius and a fix. | met — [LIMITATIONS.md](LIMITATIONS.md) |
| NFR-M4 | Coverage does not regress: line and branch floors are enforced in CI. | met — thresholds in `vitest.config.ts`, see [TESTING.md](TESTING.md#coverage) |
| NFR-M5 | Runs on Node 22+, tested in Chromium and Firefox. | met |
