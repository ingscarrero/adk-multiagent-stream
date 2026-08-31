# adk-agent-feed

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
  complete | error | cancelled`, with a guarantee that no thread is ever left
  in a non-terminal state.
- **Tool calls rendered inline**, arguments and results expandable.
- **Stop** any thread mid-stream; the others are unaffected.
- **Reload and it comes back** — the server replays what you missed.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Server on `:3001`, Vite on `:5173` (proxying `/api`) |
| `pnpm dev:recovery` | The same pair on `:3002`/`:5174` with a 40-event replay buffer, so buffer overrun and resync are reachable by hand. Open `/?debug` for the counters |
| `pnpm test` | 217 Vitest tests — protocol, reducer, adapter, HTTP/SSE, providers, evals |
| `pnpm test:e2e` | 63 Playwright tests — Chromium, Firefox, and a small-buffer recovery project |
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
| **[docs/visual/](docs/README.md)** | Seven illustrated deep-dives: the architecture and substrate boundary, the event log the feed is built on, then the reducer's gates, the ADK adapter, the SSE hub, the thread runner, and the deterministic model. |

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
support — 6 cases
thresholds: trajectory >= 1, response >= 0.5

  ✓ order-tracking               traj 1.00  resp 0.94  315ms
  ✓ order-status-no-tracking     traj 1.00  resp 0.86  161ms
  ✓ warranty-policy              traj 1.00  resp 1.00  191ms
  ✓ returns-policy               traj 1.00  resp 1.00  156ms
  ✓ no-tools-needed              traj 1.00  resp 1.00    1ms
  ✓ research-pipeline            traj 1.00  resp 0.52  160ms

6/6 passed  (avg trajectory 1.00, avg response 0.89)
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
| `SSE_REPLAY_BUFFER` | `500` | Events retained per session for reconnect |

## Known limits

Every one of these is recorded with its cause, blast radius, and fix in
**[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**. The headlines:

- **No per-subscriber backpressure** — a slow consumer is buffered in server
  memory without bound ([L2](docs/LIMITATIONS.md#l2)).
- **Session hubs are never evicted** — bounded per session, unbounded in
  sessions ([L3](docs/LIMITATIONS.md#l3)).
- **In-memory everything** — sessions, threads, replay buffers
  ([L7](docs/LIMITATIONS.md#l7)).
- **Single instance, no auth, no virtualisation**
  ([L8](docs/LIMITATIONS.md#l8)–[L10](docs/LIMITATIONS.md#l10)).
- **A thread takes one prompt** — no follow-up messages yet
  ([L4](docs/LIMITATIONS.md#l4)).

## Requirements

Node 22+ (developed on 26), pnpm 10+.

## License

Apache-2.0, matching `@google/adk`.
