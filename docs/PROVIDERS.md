# Providers: what is real, what is emulated

This repo runs end to end with no external services. Everything it needs — a
language model, a session store, an event log, a knowledge base, an identity —
is either provided in-process or stubbed.

That is a deliberate property, not an accident, and it is worth being able to
say exactly where the line falls. **This document is that line.**

## The distinction that matters

Two different things get called "fake" and they are not the same:

- **The mechanism** — the protocol, the ordering rules, the recovery flow, the
  agent graph. This is the actual solution. It is not simulated, and it would
  not change if every provider below were swapped for a real one.
- **The substrate** — where events are stored, where sessions live, what
  answers a similarity query, who says a request is authentic. This is
  infrastructure, and here most of it is emulated in-process.

A useful test: *if I swapped this for the real thing, would the code around it
change?* Where the answer is "no, just the adapter", the mechanism is sound.
Where there is no adapter to swap, the emulation is load-bearing and should be
named as such.

## Status

| | |
|---|---|
| **Ports built** | `sessions`, `knowledge`, `identity`, `eventStream`, `messageStore` |
| **Capability with no port at all** | none |
| **Real adapters built** | `model` → Gemini. The rest fail at startup with *"catalogued but not implemented yet"* |

Everything else runs emulated today. The ports exist so the real adapters are a
config change rather than a refactor.

**`messageStore` was the one capability that was absent rather than emulated**,
with the event log standing in for it. It now has a port and a memory adapter,
so the substitution test passes everywhere: swap the adapter and the code around
it does not change. What it does not yet have is a *durable* adapter, which is
the remaining half of [L7](LIMITATIONS.md#l7).

## The matrix

`GET /api/health` reports this live, so it can be checked rather than trusted:

```
capability  mode            emulated  switchable  provider
model       scripted        true      true        Gemini, Vertex AI, any ADK BaseLlm
sessions    memory          true      true        Postgres via ADK DatabaseSessionService
knowledge   keyword         true      true        Vector search: pgvector, Vertex AI Search
identity    trusted-header  true      true        OIDC / JWT
eventStream memory          true      true        Redis Streams, Kafka, NATS JetStream
messageStore memory         true      true        Postgres, DynamoDB, any keyed durable store
```

### Why the last two rows are not the same capability

They hold the same `FeedEvent`s, which is exactly what makes the distinction
worth stating. **Retention is the difference, not the shape of the record.** The
event stream answers *what happened next* over a window, addressed by offset,
and forgets. The message store answers *what is this thread*, addressed by id,
and does not.

The store also holds strictly less: settled events only, never `message.delta`.
A delta exists to show text before it is finished, and `message.complete`
carries the authoritative full text — so storing deltas would be about five
times the writes for nothing a reader would ever ask for.

### Why storage and delivery are one row, not two

They were two — `eventLog` and `fanout` — and that was wrong. Only two of the
four combinations are coherent:

| log | delivery | |
|---|---|---|
| memory | in-process | ✅ single instance |
| shared | shared | ✅ multi-instance |
| memory | shared | ❌ an instance that never held the events cannot replay them |
| shared | in-process | ❌ works, buys nothing |

And every real provider serves both from one primitive: Redis Streams is
`XADD` / `XRANGE` / `XREAD BLOCK`; Kafka is a topic you produce to and consume
from. Splitting them advertised a seam no implementation has.

"Fan-out" was also already taken in this repo — it means a `ParallelAgent`
running its children concurrently.

| Capability | Real-world provider | Emulated with | Flag | Seam |
|---|---|---|---|---|
| **LLM inference** | Gemini, Vertex AI, any ADK `BaseLlm` | `ScriptedLlm` — deterministic, in-process | `MODEL_MODE` | `packages/agents/src/model.ts` |
| **Agent sessions** | Postgres/MySQL via ADK `DatabaseSessionService`; `VertexAiSessionService` | ADK `InMemorySessionService` | `PROVIDER_SESSIONS` | `packages/providers/src/sessions` |

The sessions row carries more weight than it used to. A follow-up turn is
answered from conversation history, and a paused tool call is resumed by ADK
finding the confirmation in that same history — so with the memory adapter, a
restart does not just lose the transcript, it loses the agent's *context*. Two
features now depend on that provider rather than one docs page mentioning it.
| **Knowledge retrieval** | Vector DB — pgvector, Vertex AI Search, Pinecone; ADK ships `VertexAiRagRetrievalTool` | keyword match over 3 fixture articles | `PROVIDER_KNOWLEDGE` | `packages/providers/src/knowledge` |
| **Embeddings** | Gemini `text-embedding-*` | deterministic hashed vectors | `PROVIDER_EMBEDDINGS` | `packages/providers/src/knowledge` |
| **Event stream** — storage, retention, replay and delivery | Redis Streams, Kafka, NATS JetStream | bounded in-process array plus a set of listeners | `PROVIDER_EVENTSTREAM` | `packages/providers/src/eventstream` |
| **Message store** — the durable transcript | Postgres, DynamoDB, any keyed durable store | unbounded in-process Map, keyed by thread | `PROVIDER_MESSAGESTORE` | `packages/providers/src/messagestore` |
| **Identity** | OIDC / JWT | client-supplied session id, trusted | `PROVIDER_IDENTITY` | `packages/providers/src/identity` |
| **Business data (orders)** | An order service over HTTP | 3 fixture records + a fixed `sleep` | — | `packages/agents/src/tools.ts` |

### Absent, and named so they are not assumed

Named so they are not mistaken for something that exists:

| Capability | What a real system would use | Status |
|---|---|---|

| Telemetry / tracing | OpenTelemetry → GCP or Datadog; ADK ships `@google/adk/telemetry/gcp` | not wired |
| Artifacts / blobs | GCS; ADK ships `@google/adk/artifacts/gcs` | unused |
| Long-term memory | Vertex AI Memory Bank | unused |
| Remote tools | MCP servers; ADK ships `@google/adk/tools/mcp` | unused — tools are local functions |

## The one to look at hardest

**`searchKnowledgeBase` is keyword matching, not retrieval.** It lowercases the
query, splits on non-word characters, and counts tag hits across three
hardcoded articles. It has the shape of RAG — a query goes in, ranked documents
come out, the agent grounds its answer in them — and none of the substance.

Its three failure modes are asserted in `packages/providers/src/providers.test.ts`
rather than described, so the claim can be checked:

| Query | Returns | Why |
|---|---|---|
| `return` | the returns article | literal token hit |
| `returns` | **nothing** | `'return'.includes('returns')` is false — one extra letter loses the document |
| `how long do I have to send it back` | **all three articles** | `I` survives tokenisation as one character and matches every tag containing an `i`. Noise, not recall |
| `send this back for money` | **nothing** | a plain paraphrase sharing no literal token. A vector search finds this |

Nothing else in this repo is as easy to mistake for the real thing, which is
why it is first on the list to get a genuine adapter.

## Rules this follows

1. **Emulated is the default.** `pnpm install && pnpm dev` works with no
   services, no keys, no containers. Every real provider is opt-in.
2. **CI runs fully emulated.** The suite stays hermetic and needs no
   infrastructure. Real adapters have their own opt-in lane.
3. **A port exists only where a real implementation is in view.** Interfaces
   invented for symmetry are architecture cosplay; they make a codebase look
   considered while proving nothing.
4. **The health endpoint reports the truth.** Which mode each capability is in
   is observable at runtime, not asserted in a document that can drift.

## Running against real providers

**Not yet possible.** `MODEL_MODE=gemini` is the only real adapter that exists;
every other capability fails at startup with *"catalogued but not implemented
yet"* if you switch it. There is no `compose.yaml` and no `infra:up` script.

This section previously described `pnpm infra:up` and `pnpm dev:real` as though
they worked. They never did — the plan was written in the present tense. It is
the same failure the [rule at the top of LIMITATIONS.md](LIMITATIONS.md#the-rule-this-file-exists-to-enforce)
exists to prevent, found by auditing these documents against the repo.

The plan, stated as a plan:

| Step | Contents |
|---|---|
| `compose.yaml` | Podman-first (rootless, no daemon), fully-qualified images: `docker.io/pgvector/pgvector:pg17`, `docker.io/library/redis:7-alpine`. Compose Spec, so `docker compose` works too |
| `pnpm infra:up` / `infra:down` | wrap `podman compose` |
| `pnpm dev:real` | every capability switched to its real adapter at once |

Adapter order, and the reasoning: **messageStore** first, because it is the one
missing *capability* rather than a missing implementation of an existing one
([L7](LIMITATIONS.md#l7)); then **sessions**, which shares its Postgres;
then **knowledge**, the emulation most easily mistaken for the real thing;
then **eventStream**, which buys multi-instance;
then **identity**, which needs a client change as well as a server one.
