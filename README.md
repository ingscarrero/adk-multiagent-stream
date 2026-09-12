# adk-agent-feed

[![CI](https://github.com/ingscarrero/adk-multiagent-stream/actions/workflows/ci.yml/badge.svg)](https://github.com/ingscarrero/adk-multiagent-stream/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-90.8%25_lines_%C2%B7_81.9%25_branches-brightgreen)](docs/TESTING.md#coverage)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](.nvmrc)
[![pnpm 10](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](package.json)

A real-time message feed for **multiple concurrent AI agent threads**, built on
[Google's Agent Development Kit for JS](https://github.com/google/adk-js)
(`@google/adk` v2.0.0), React 19, and Playwright.

Several agent threads stream at once over a single connection. Messages stay in
order, each thread's status tracks its own lifecycle, and the whole thing is
tested — including the streaming behaviour — without a single API key.

```bash
pnpm install
pnpm dev          # → http://localhost:5173
```

That is the entire setup. `MODEL_MODE` defaults to `scripted`, an in-process
deterministic model, so the app runs, tests, and evaluates itself completely
offline. Add a `GOOGLE_API_KEY` and set `MODEL_MODE=gemini` when you want the
real thing.

---

## What it does

Send a prompt, then send another before the first finishes. Both stream.

- **Two agent shapes.** A **router** that hands off to specialists via ADK's
  `transfer_to_agent`, and a **research pipeline** that fans out to two agents
  in parallel and then synthesises their findings.
- **Live thread status** — `queued → running → streaming → awaiting_tool →
  complete | error | cancelled`, with a guarantee that every turn ends in a
  terminal status or in a pause the client can answer.
- **Follow-up turns** — reply inside a thread and the agent answers from the
  conversation so far, because the ADK session is reused.
- **Human-in-the-loop approval** — a refund over $50 pauses on `awaiting_input`
  and shows the arguments before it runs. Approve or deny.
- **Tool calls rendered inline**, arguments and results expandable.
- **Stop** any thread mid-stream; the others are unaffected. (Use `pnpm dev:demo`
  to see this — at the default pacing a scripted thread finishes in ~0.5s and the
  control is gone before you can click it: [L17](docs/LIMITATIONS.md#l17).)
- **Reload and it comes back** — the server replays what you missed.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Server on `:3001`, Vite on `:5173` (proxying `/api`) |
| `pnpm dev:demo` | The same pair, paced so a human can watch. Scripted threads finish in ~0.5s at the default, which makes **Stop** appear and vanish before you can click it ([L17](docs/LIMITATIONS.md#l17)); this slows streaming and tool latency so cancellation, tool steps and partial text are all observable |
| `pnpm dev:recovery` | The same pair on `:3002`/`:5174` with a 40-event replay buffer, so buffer overrun and resync are reachable by hand. Open `/?debug` for the counters |
| `pnpm test` | 344 Vitest tests — protocol, reducer, components, adapter, HTTP/SSE, providers, message store, tools, evals |
| `pnpm test:coverage` | The same suite with the coverage report and the line/branch floors CI enforces |
| `pnpm test:e2e` | 81 Playwright tests — Chromium, Firefox, and a small-buffer recovery project |
| `pnpm eval` | Agent behavioural evals, ADK-style |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm lint` | ESLint, type-aware |
| `pnpm check` | All of the above, in CI order |

## Layout

```
packages/protocol/   wire schemas + thread status machine   (no ADK)
packages/agents/     agent graph, tools, deterministic model
packages/providers/  the emulated/real substrate boundary   (ports + adapters)
packages/eval/       ADK-style evaluation (ADK ships this in Python only)
apps/server/         Express 5, multiplexed SSE, ADK adapter
apps/web/            React 19 feed                          (no ADK)
e2e/                 Playwright specs and page objects
docs/                architecture, protocol, testing, limits, providers
```

## Documentation

Index and conventions in **[docs/](docs/README.md)**.

| | |
|---|---|
| **[docs/STREAMING-CONTRACT.md](docs/STREAMING-CONTRACT.md)** | The protocol. Ordering, reconnect, status, and the reasoning behind each. **Start here.** |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | How the pieces fit, and four things about ADK worth knowing before reading the code. |
| **[docs/TESTING.md](docs/TESTING.md)** | The four test layers, why the suite isn't flaky, and what isn't covered. |
| **[docs/LIMITATIONS.md](docs/LIMITATIONS.md)** | Every known gap and follow-up, with cause, blast radius, and fix. |
| **[docs/PROVIDERS.md](docs/PROVIDERS.md)** | Emulated versus real: what stands in for Kafka, a vector DB, a session store, an identity provider — and where each seam is. |
| **[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)** | Functional requirements traced to endpoints and tests; non-functional requirements including security, cost and accessibility. |
| **[docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md)** | Goals, constraints, rejected alternatives, failure modes, the scaling path, and the cost envelope. |
| **[docs/adr/](docs/adr/README.md)** | Six architecture decision records. |
| **[docs/visual/](docs/visual/overview.html)** | Ten illustrated deep-dives, starting with **[Prompt to Pixel](docs/visual/overview.html)** — the whole solution on one page. Then the substrate boundary, the event log, the reducer's gates, the ADK adapter, the SSE hub, the thread runner, the deterministic model, the agent evals, and the browser suite. |

Every source file opens with a docblock explaining what it owns and why it is
shaped that way. The interesting reasoning is next to the code, not here.

---

## The three decisions that shape everything

### 1. One SSE connection carries every thread

Not one per thread. Browsers allow **six** concurrent HTTP/1.1 connections per
origin, so per-thread streams break at the seventh concurrent thread — and only
under concurrency, which is the condition a demo doesn't hit and production
does.

Multiplexing means the server must demultiplex (`threadId` on every event) and
must separate two different counters:

- **`seq`** — per **thread**, monotonic from 1. This is the ordering guarantee.
- **`offset`** — per **session**, the SSE `id:` field. This is `Last-Event-ID`
  resume, and nothing else.

Conflating them is the classic bug: one global counter can't express per-thread
order once threads interleave, and one per-thread counter can't drive
`Last-Event-ID` on a shared connection.

### 2. The model is deterministic, so the tests can be real

A streaming UI is mostly timing, and timing tests against a live LLM are flaky
by construction. Every test here runs against `ScriptedLlm`, a `BaseLlm`
implementation that mirrors `GoogleLlm`'s exact streaming shape — N partial
responses, then one final non-partial response carrying the full text — while
producing byte-identical output every run.

That is what makes assertions like *"the concatenated deltas equal the final
text"* and *"the second tool call is `checkShippingStatus`"* reasonable rather
than hopeful.

### 3. The browser never sees ADK

`apps/web` and `packages/protocol` contain no reference to `@google/adk` — the
UI and the wire contract are framework-free, and would survive replacing ADK
entirely. Server-side, `apps/server/src/adk-adapter.ts` is the single place ADK
`Event`s become wire `FeedEvent`s.

(ADK itself is imported across `packages/agents`, `packages/providers` and the
server — it is the agent runtime, not a detail. The invariant worth having is
the one above: it never reaches the client.)

So the reducer — where all the ordering logic lives — is testable with array
literals:

```ts
reduceAll(initialFeedState, [created(), delta(4, 'C'), delta(3, 'B'), delta(2, 'A')]);
// → "ABC"   reassembled in seq order, not arrival order
```

Out-of-order frames, duplicates after reconnect, gaps that never close: all
synchronous, all sub-millisecond, none requiring a browser.

---

## Evals: the part ADK-JS doesn't have

ADK's evaluation tooling — `AgentEvaluator`, evalset files, `adk eval` — ships
in **adk-python only**. `@google/adk` v2.0.0 has no equivalent. `packages/eval`
is a small TypeScript implementation of the same ideas, using ADK's metric names
so the numbers mean the same thing:

```
support — 7 cases
thresholds: trajectory >= 1, response >= 0.5

  ✓ order-tracking               traj 1.00  resp 0.94  315ms
  ✓ order-status-no-tracking     traj 1.00  resp 0.86  161ms
  ✓ warranty-policy              traj 1.00  resp 1.00  191ms
  ✓ returns-policy               traj 1.00  resp 1.00  156ms
  ✓ no-tools-needed              traj 1.00  resp 1.00    1ms
  ✓ research-pipeline            traj 1.00  resp 0.52  160ms
  ✓ refund-requires-approval     traj 1.00  resp 1.00    3ms

7/7 passed  (avg trajectory 1.00, avg response 0.90)
```

`tool_trajectory_avg_score` matters more than it first looks: two agents can
give the same answer while one looked the order up and the other guessed. Only
the trajectory tells them apart.

The same evalset runs inside `pnpm test`, so a prompt or graph change can't land
without the behavioural expectations being rechecked.

---

## Four things about `@google/adk` v2.0.0

Found while building this. Each is pinned by a regression test named after the
symptom, so an ADK upgrade breaks a named test rather than the app.

1. **`transfer_to_agent` takes `agentName`** — camelCase in adk-js, snake_case
   (`agent_name`) in adk-python. The wrong spelling is a *silent no-op*, not an
   error.
2. **Transfer rewrites history.** The receiving agent doesn't get the raw event
   log; ADK converts the previous agent's tool calls into synthetic **user**
   messages prefixed `"For context:"`. Anything reading "the latest user
   message" must skip them, or every agent downstream of a transfer answers the
   wrong question.
3. **`StreamingMode.BIDI` throws.** Only `NONE` and `SSE` work. SSE isn't a
   preference here — it's the supported mode.
4. **`SequentialAgent` and `ParallelAgent` are deprecated** in favour of the new
   `Workflow` graph API, while the same warning notes `Workflow` can't yet be an
   `LlmAgent` sub-agent. They're kept deliberately; the reasoning is in
   [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Two SSE lessons, learned the hard way

Both cost real debugging time; both are now tested.

**Write a body byte immediately.** `res.flushHeaders()` flushes *your* response,
but an intermediary — a dev proxy, nginx, a load balancer — has its own outbound
response, and Node won't put those headers on the wire until something writes a
body chunk. On an idle feed that could be a heartbeat 15 seconds later, and the
browser's `EventSource` sits in `CONNECTING` without firing `onopen`. A priming
`retry:` + comment frame fixes it and sets the reconnect backoff at the same
time.

**`EventSource` auto-retry isn't portable.** Chromium retries a dropped stream
indefinitely; Firefox gives up on some failures and parks the connection in
`CLOSED`. The client watches `readyState` and re-creates the connection itself —
and since a hand-made connection doesn't carry `Last-Event-ID`, the server also
accepts `?lastEventId=`. This is why the Playwright suite runs in two engines.

**A third, found by auditing the docs against the code.** The server announced
replay-buffer overruns with a `resync` frame that the client never listened for,
so a thread could vanish from the feed in silence — while four places in the
docs and source claimed the mechanism worked. Recovery is now closed end to end
through `GET /api/threads`, and the counter that hid it (`stats.dropped`, which
lumped healthy replay drops together with real data loss) is split into
`droppedRedundant` and `droppedLossy`.

---

## Configuration

Everything is optional. See [`.env.example`](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `MODEL_MODE` | `scripted` | `scripted` \| `gemini` |
| `GOOGLE_API_KEY` | — | Required only for `gemini` |
| `GEMINI_MODEL` | `gemini-2.5-flash` | |
| `PORT` | `3001` | Pinned to 3001 by `pnpm dev`, so an inherited `PORT` can't move the API onto the web app's port |
| `SSE_HEARTBEAT_MS` | `15000` | Keeps idle proxies from closing the stream |
| `SSE_RETRY_MS` | `1000` | The `retry:` value in the priming frame — the browser's reconnect backoff, honoured by `EventSource` with no client code |
| `SSE_MAX_BUFFERED_BYTES` | `1048576` | Bytes queued for one subscriber before it is disconnected. Bounds what a stalled consumer can cost ([L2](docs/LIMITATIONS.md#l2)) |
| `SESSION_IDLE_TTL_MS` | `900000` | How long an unwatched session may sit before its hub and retained events are released ([L3](docs/LIMITATIONS.md#l3)) |
| `SESSION_SWEEP_INTERVAL_MS` | `60000` | How often to run that sweep |
| `SCRIPTED_CHUNK_DELAY_MS` | `25` | Delay between streamed chunks in scripted mode. `pnpm dev:demo` sets this to `200`; at the default a thread finishes in ~0.5s and the Stop button is gone before you can click it ([L17](docs/LIMITATIONS.md#l17)) |
| `TOOL_LATENCY_MS` | `150` | Simulated latency per tool call, scripted mode only. `pnpm dev:demo` sets this to `400` |
| `EVENT_RETENTION` | `500` | Events retained per session for reconnect. `SSE_REPLAY_BUFFER` is still honoured as the older name |
| `SNAPSHOT_TRANSCRIPT_LIMIT` | `1000` | Settled events `GET /api/threads` carries per thread, newest first; a capped thread is flagged `transcriptTruncated` ([L7](docs/LIMITATIONS.md#l7)) |
| `PROVIDER_SESSIONS` \| `_KNOWLEDGE` \| `_IDENTITY` \| `_EVENTSTREAM` \| `_MESSAGESTORE` | all emulated by default | Which adapter backs each capability. `GET /api/health` reports the live values. See [docs/PROVIDERS.md](docs/PROVIDERS.md) |

## Known limits

Every one of these is recorded with its cause, blast radius, and fix in
**[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**. The headlines:

- **Everything is in memory** — sessions, threads, the event log and the
  transcript, so nothing survives a restart. Sessions, the event log and the
  transcript each have a port with no durable adapter yet; the thread registry
  has no port at all and lives in a private map, so restart recovery is more
  than an adapter swap ([L7](docs/LIMITATIONS.md#l7)).
- **Single instance, no auth, no virtualisation**
  ([L8](docs/LIMITATIONS.md#l8)–[L10](docs/LIMITATIONS.md#l10)).
- **No responsive breakpoints** — desktop widths only
  ([L6](docs/LIMITATIONS.md#l6)).

## Requirements

Node 22+ (developed on 26), pnpm 10+.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) has the gate and where a change goes;
[SECURITY.md](SECURITY.md) states the security boundary and how to report a
problem privately; [CHANGELOG.md](CHANGELOG.md) records what landed when.

## License

[MIT](LICENSE). `@google/adk` is Apache-2.0 and is consumed as a dependency.
