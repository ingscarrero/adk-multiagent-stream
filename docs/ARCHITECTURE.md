# Architecture

## The shape

```
┌─────────────────────────────────────────────────────────┐
│  apps/web            React 19 + Vite                    │
│                                                         │
│   App ── useFeedStream ── EventSource ──┐               │
│            │                            │               │
│            └── feedReducer (pure)       │               │
│                  ordering, dedup, gaps  │               │
└─────────────────────────────────────────┼───────────────┘
                                          │ SSE (one connection)
┌─────────────────────────────────────────┼───────────────┐
│  apps/server         Express 5          ▼               │
│                                                         │
│   routes ── ThreadRunner ── SessionHub ──► subscribers  │
│                  │            (seq, replay buffer)      │
│                  ▼                                      │
│           AdkEventTranslator   ◄── the only ADK seam    │
└──────────────────┬──────────────────────────────────────┘
                   │ ADK Event stream
┌──────────────────▼──────────────────────────────────────┐
│  packages/agents     @google/adk 2.0.0                  │
│                                                         │
│   router: LlmAgent ──transfer──► order_agent, kb_agent  │
│   research: Sequential(Parallel(a, b), synthesizer)     │
│   model: ScriptedLlm (default) | Gemini                 │
└─────────────────────────────────────────────────────────┘

  packages/protocol   zod schemas + status machine, shared by all of the above
  packages/eval       ADK-style agent evaluation (Python-only in ADK itself)
```

## The one rule that shapes everything

**ADK types stop at `apps/server/src/adk-adapter.ts`.**

Nothing in `@feed/web` or `@feed/protocol` imports `@google/adk`. The browser,
the reducer, and every Playwright assertion are written against `FeedEvent`, a
plain zod-validated union.

Three things fall out of that:

- The reducer is testable with array literals — no agent framework, no network,
  no timers. That is why the ordering tests are cheap enough to be exhaustive.
- Replacing ADK means rewriting one file.
- The UI cannot accidentally depend on an ADK implementation detail, because it
  cannot see one.

## Packages

| Package | What it owns | Depends on ADK? |
|---|---|---|
| `packages/protocol` | Wire schemas, `ThreadStatus` machine | no |
| `packages/agents` | Agent graph, tools, `ScriptedLlm`, model resolution | yes |
| `packages/eval` | Evalset format, metrics, runner, CLI | yes |
| `apps/server` | HTTP, SSE hub, thread lifecycle, ADK adapter | yes (adapter only) |
| `apps/web` | React feed, reducer, hooks | no |
| `e2e` | Playwright specs, page objects, fixtures | no |

Workspace packages are consumed as **TypeScript source** (`exports` points at
`src/index.ts`). There is no build step between packages: `tsx` runs the server,
Vite handles the browser, and `tsc --noEmit` typechecks each package. One less
layer between an edit and seeing it work.

## The agent graph

Two entrypoints, chosen because they stress a streaming feed in different ways.

### `router` — agent transfer

```
support_router ──transfer_to_agent──► order_agent  (lookupOrder, checkShippingStatus)
                                  └─► kb_agent     (searchKnowledgeBase)
```

One thread whose `author` changes mid-stream. The feed has to re-attribute text
without starting a new thread.

### `research` — parallel fan-out then synthesis

```
research_pipeline (Sequential)
├── parallel_research (Parallel)
│   ├── market_researcher ─► session state `market_finding`
│   └── docs_researcher   ─► session state `docs_finding`
└── synthesizer  (reads both findings from state)
```

Two agents emit **interleaved** partial text on one invocation. This is the case
that breaks naive feeds: without a per-thread `seq` and a per-author
`messageId`, two agents streaming at once produce one scrambled message.

Agent trees are built **fresh per thread**. ADK agents hold a `parentAgent`
back-reference, so sharing one instance across concurrent threads corrupts
transfer routing.

## Four things about ADK worth knowing before you read the code

These were all found by building against `@google/adk` v2.0.0, and each is
pinned by a named regression test.

1. **`transfer_to_agent` takes `agentName`, not `agent_name`.** adk-python uses
   snake_case; adk-js uses camelCase. Getting it wrong makes transfer a silent
   no-op rather than an error.

2. **Transfer rewrites history.** The receiving agent does not get the raw event
   log. ADK converts the previous agent's tool calls and results into synthetic
   **user** messages prefixed `"For context:"`. Anything reading "the latest user
   message" must skip those frames, or every agent downstream of a transfer sees
   `"For context: … Transfer queued"` instead of the actual question.

3. **`StreamingMode.BIDI` throws.** Only `NONE` and `SSE` work in v2.0.0.

4. **`SequentialAgent` and `ParallelAgent` are deprecated** in favour of the new
   `Workflow` graph API — while the same warning notes that `Workflow` cannot
   yet be an `LlmAgent` sub-agent. They are kept here on purpose: they still
   work, and they are what the ADK guides teach. The migration is contained to
   `buildResearch`, and the feed layer would not change at all, because
   `Workflow` emits the same `Event` shape.

## Model modes

| `MODEL_MODE` | Model | Used by |
|---|---|---|
| `scripted` (default) | `ScriptedLlm`, in-process, deterministic | every test, every eval, CI |
| `gemini` | real Gemini via `GOOGLE_API_KEY` | manual exploration |

`LlmAgent.model` accepts `string | BaseLlm`, so the two modes differ in exactly
one expression (`packages/agents/src/model.ts`) and nothing downstream branches.

`ScriptedLlm` mirrors `GoogleLlm`'s streaming shape precisely: N partial
responses carrying only the new chunk, then one final non-partial response
carrying the whole text. That fidelity is what makes it safe to write the
adapter against the fake and trust it against the real one.

## Deliberate limits

The complete register — including gaps that are *not* deliberate — is
[LIMITATIONS.md](LIMITATIONS.md). The ones that shape the architecture:

- **In-memory everything.** Sessions, threads, replay buffers. ADK's
  `DatabaseSessionService` is a one-line swap in `thread-runner.ts`.
- **Single instance.** One process owns a session's hub. Multi-instance needs
  sticky sessions or a shared pub/sub.
- **No auth.** `sessionId` is client-generated and unauthenticated. Real
  deployments need a real identity on the stream.
- **`maxLlmCalls: 20`** per run, as a runaway-loop backstop.
