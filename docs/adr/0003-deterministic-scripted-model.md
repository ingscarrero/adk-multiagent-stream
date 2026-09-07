# ADR-0003: Every test runs against a deterministic scripted model

**Date:** 2026-08-31 · **Status:** accepted

## Context

A streaming UI is mostly timing. Tests against a live LLM vary in token
count, latency and whether a tool is called at all, so any assertion about
ordering or interleaving is flaky by construction — and the interesting cases
(two agents interleaving, a transfer mid-stream, a tool pause) cannot be
produced on demand.

## Decision

`ScriptedLlm`, a `BaseLlm` implementation that mirrors `GoogleLlm`'s exact
streaming shape — N partial responses each carrying only the new chunk, then
one final non-partial response carrying the whole text — while producing
byte-identical output every run. Branches are selected by regex over the
prompt; turns are text, tool calls, transfers or errors.

`MODEL_MODE=scripted` is the default. `MODEL_MODE=gemini` is the only real
adapter and is exercised by hand, never in CI. `LlmAgent.model` accepts
`string | BaseLlm`, so the two modes differ in one expression.

The eval harness (`packages/eval`) runs the same evalset as a CLI and inside
`pnpm test`, scoring tool trajectory strictly and response text loosely.

## Alternatives

| | Why it lost |
|---|---|
| Recorded fixtures (VCR) | Brittle across prompt edits; cannot produce interleaving or a pause on demand; still no control over pacing |
| Mocking at the ADK `Runner` | Skips the runtime whose behaviour the design depends on (transfer rewriting history, parallel interleaving); those are the properties worth pinning |
| A live model in CI | Flaky, costs money, needs a secret |

## Consequences

- Assertions like "the concatenated deltas equal the final text" and "the
  second tool call is `checkShippingStatus`" are reasonable rather than
  hopeful.
- The suite is hermetic: no key, no network, no service, anywhere.
- Scripted pacing makes Stop unreachable by hand at the default (L17); a
  second run mode (`pnpm dev:demo`) exists for humans rather than changing the
  default the tests exercise.
- Event counts per thread are known for scripted mode and **unmeasured** for
  Gemini; retention defaults were sized against the scripted figure.
