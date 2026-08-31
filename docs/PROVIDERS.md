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
| **Ports built** | `sessions`, `knowledge`, `identity` |
| **Catalogued, no port yet** | `eventLog`, `fanout` — still hard-wired in `SessionHub` |
| **Real adapters built** | `model` → Gemini. The rest fail at startup with *"catalogued but not implemented yet"* |

Everything runs emulated today. The ports exist so the real adapters are a
config change rather than a refactor; they land next.

## The matrix

`GET /api/health` reports this live, so it can be checked rather than trusted:

```
capability  mode            emulated  switchable  provider
model       scripted        true      true        Gemini, Vertex AI, any ADK BaseLlm
sessions    memory          true      true        Postgres via ADK DatabaseSessionService
knowledge   keyword         true      true        Vector search: pgvector, Vertex AI Search
identity    trusted-header  true      true        OIDC / JWT
eventLog    memory          true      false       Redis Streams, Kafka, NATS JetStream
fanout      inprocess       true      false       Redis pub/sub, NATS, Postgres LISTEN/NOTIFY
```

`switchable: false` means the capability is named for honesty but is still
hard-wired — there is no port yet. Better shown as a known gap than omitted.

| Capability | Real-world provider | Emulated with | Flag | Seam |
|---|---|---|---|---|
| **LLM inference** | Gemini, Vertex AI, any ADK `BaseLlm` | `ScriptedLlm` — deterministic, in-process | `MODEL_MODE` | `packages/agents/src/model.ts` |
| **Agent sessions** | Postgres/MySQL via ADK `DatabaseSessionService`; `VertexAiSessionService` | ADK `InMemorySessionService` | `PROVIDER_SESSIONS` | `packages/providers/src/sessions` |
| **Knowledge retrieval** | Vector DB — pgvector, Vertex AI Search, Pinecone; ADK ships `VertexAiRagRetrievalTool` | keyword match over 3 fixture articles | `PROVIDER_KNOWLEDGE` | `packages/providers/src/knowledge` |
| **Embeddings** | Gemini `text-embedding-*` | deterministic hashed vectors | `PROVIDER_EMBEDDINGS` | `packages/providers/src/knowledge` |
| **Event log / replay window** | Kafka, Redis Streams, NATS JetStream | bounded in-process array | `PROVIDER_EVENTLOG` | `packages/providers/src/eventlog` |
| **Cross-instance fan-out** | Redis pub/sub, NATS, Postgres `LISTEN/NOTIFY` | a `Set` of open responses | `PROVIDER_FANOUT` | `packages/providers/src/fanout` |
| **Identity** | OIDC / JWT | client-supplied session id, trusted | `PROVIDER_IDENTITY` | `packages/providers/src/identity` |
| **Business data (orders)** | An order service over HTTP | 3 fixture records + a fixed `sleep` | — | `packages/agents/src/tools.ts` |

### Not emulated — simply absent

Named so they are not mistaken for something that exists:

| Capability | What a real system would use | Status |
|---|---|---|
| **Message/transcript store** | Postgres, DynamoDB | **absent.** The replay buffer is the only place agent messages exist ([L7](LIMITATIONS.md#l7)) |
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

Containers are Podman (rootless, no daemon):

```bash
podman machine start          # macOS only, first time: podman machine init
pnpm infra:up                 # postgres + pgvector, redis
pnpm dev:real                 # every provider switched to its real adapter
pnpm infra:down
```

`compose.yaml` follows the Compose Spec, so `docker compose` works too if that
is what you have.
