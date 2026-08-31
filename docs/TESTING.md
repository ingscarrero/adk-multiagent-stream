# Testing

```
pnpm check     # typecheck → lint → unit/integration → e2e
pnpm test      # vitest (node + jsdom)
pnpm test:e2e  # playwright (chromium + firefox)
pnpm eval      # agent behavioural evals
```

Everything runs offline. No API key, anywhere, ever.

## Why the suite is not flaky

A streaming UI is mostly *timing*, and timing tests against a real LLM are flaky
by construction: token counts vary, latency varies, the model may or may not
call a tool. So **every test runs against `ScriptedLlm`** — a deterministic
in-process `BaseLlm` that produces byte-identical output on every run.

That single decision is what makes the rest possible. Assertions like "the
second tool call is `checkShippingStatus`" or "the concatenated deltas equal the
final text" are only reasonable against a model that behaves the same way twice.

The real Gemini path stays wired up and is exercised by hand. It is simply never
on the critical path of CI.

## The four layers

| Layer | Runner | Count | What it proves |
|---|---|---|---|
| Protocol, reducer & components | Vitest (node/jsdom) | 95 | Ordering rules, status machine, wire schemas, the stream hook |
| Server | Vitest (node) | 38 | Adapter mapping, real HTTP/SSE, concurrency, reconnect, cancellation |
| Providers | Vitest (node) | 36 | Config validation, plus contract suites for the knowledge and event-stream ports |
| Evals | Vitest (node) | 25 | Retrieval metrics and the agent regression gate |
| ADK integration | Vitest (node) | 23 | Agents actually run under a real `Runner`, with transfer and parallel fan-out |
| Browser | Playwright | 63 | The whole stack, in two engines plus a small-buffer recovery project |

217 in `pnpm test`, 63 in `pnpm test:e2e`, and 6 eval cases that run both as a
CLI and inside the unit suite.

### Contract tests

`packages/providers` is tested through its *ports*, not its implementations.
`knowledgeContract(name, make)` and `streamContract(name, make)` are suites any
adapter of those ports must pass. The emulated adapters run them today; the
Redis and vector adapters will run the identical suites, so a divergence
surfaces as a failure rather than as a surprise in production.

The event-stream contract is the more interesting of the two, because it pins
the properties `SessionHub` depends on: offsets are dense and start at 1,
retention is observable through `oldestOffset` (which is what overrun detection
reads), and nothing is lost or duplicated across the `open`/`flush` boundary —
the race that made those two operations a single call.

### Layer 1 — the reducer is where ordering is really tested

`apps/web/src/feed/reducer.ts` is a pure function. Every hazard a real stream can
produce is an array literal:

```ts
reduceAll(initialFeedState, [created(), delta(4, 'C'), delta(3, 'B'), delta(2, 'A')]);
// → "ABC"  — reassembled in seq order, not arrival order
```

Out-of-order frames, duplicates after reconnect, gaps that never close, two
agents interleaving — all synchronous, all sub-millisecond. Cases that would be
flaky or impossible to trigger through a browser are ordinary assertions here.

The status machine gets the same treatment: all 64 `(from, to)` pairs are
asserted against a table written independently of the implementation, so adding
a transition without deciding to fails a test.

### Layer 2 — pinning what we assume about ADK

`packages/agents/src/agents.test.ts` runs the real `InMemoryRunner`. It asserts
the properties the feed design depends on:

- transfer actually routes to the specialist;
- parallel branches **interleave** rather than running one after the other;
- the synthesizer runs strictly after both researchers.

If ADK changes any of that, a named test fails instead of the UI quietly getting
worse.

Adapter tests (`apps/server/src/adk-adapter.test.ts`) use hand-built ADK events
rather than recorded ones. Hand-building is the point: each fixture states one
ADK behaviour we rely on, visible to a reader.

### Layer 3 — a real server and a real stream

`apps/server/src/stream.test.ts` boots Express on an ephemeral port and parses
SSE frames off the socket. Nothing is mocked except the model.

Representative assertions:

```ts
// per-thread sequences are independent and gapless, with three threads running
expect(forThread.map((e) => e.seq)).toEqual([1, 2, 3, ...]);

// the deltas reconstruct the final text exactly
expect(rebuilt).toBe(complete.text);

// reconnect from Last-Event-ID leaves no overlap and no gap
expect(combined.map((e) => e.seq)).toEqual([1, 2, 3, ...]);
```

### Layer 4 — Playwright

**Zero `waitForTimeout`.** Every assertion is web-first (`expect(locator)`), so
Playwright retries until the condition holds. A fixed sleep in a streaming test
is a race that has not failed yet.

**Page objects.** No spec touches a selector. Specs speak in "the thread whose
prompt is X" and "its status"; `e2e/pages/FeedPage.ts` owns the mapping. Every
accessor returns a `Locator` rather than a resolved value, so auto-waiting
survives the abstraction.

**Both engines, for a reason.** `EventSource` retry behaviour differs between
Chromium and Firefox — Firefox parks a failed connection in `CLOSED` and never
retries. That bug was found by running the suite in Firefox, and the fix (an
explicit reconnect in `useFeedStream`) is guarded there.

**Console errors fail tests.** The `consoleErrors` fixture catches the class of
bug that leaves the UI looking fine while React throws in an effect. A test that
breaks something on purpose declares it:

```ts
allowConsoleError(testInfo, /establish a connection/, 'the stream is blocked deliberately');
```

Per-test rather than global, and it shows up in the HTML report — so a reader can
see which tests suppress what, and why.

**Accessibility is tested twice.** `@axe-core/playwright` scans empty,
streaming, errored, and dark-mode states; separate assertions cover what axe
cannot judge — whether the *right* content is in a live region. A feed that
announces every streaming token is technically conformant and practically
unusable, so the specs assert that streaming prose is **not** live and that each
thread has exactly one live region for its status.

The axe scan has already paid for itself: it caught two genuine contrast
failures in the light palette (4.49:1 against a 4.5:1 threshold, and a
translucent error code that blended below the line).

## Evals: testing the agent, not the code

Unit tests check that the code does what it says. Evals check that the **agent**
still behaves — that it uses the right tools, in the right order, and grounds its
answer in what they returned.

ADK's evaluation tooling is **Python-only**; `@google/adk` v2.0.0 ships no
equivalent. `packages/eval` is a small reimplementation in TypeScript, using
ADK's metric names so the numbers mean the same thing.

```
support — 6 cases
  ✓ order-tracking             traj 1.00  resp 0.94  315ms
  ✓ warranty-policy            traj 1.00  resp 1.00  191ms
  ...
6/6 passed  (avg trajectory 1.00, avg response 0.89)
```

| Metric | What it measures |
|---|---|
| `tool_trajectory_avg_score` | Per-step match of the tool sequence, order-sensitive. Arguments compared as a subset, so a new optional parameter is not a regression. |
| `response_match_score` | ROUGE-1 F1 against a reference answer. F1 rather than recall, so padding an answer with the reference does not score well. |

Trajectory matters more than it first appears: two agents can produce the same
final answer while one looked the order up and the other guessed. Only the
trajectory tells them apart.

The same evalset runs inside `pnpm test`, so a prompt or graph change cannot
land without the behavioural expectations being rechecked.

## What is not tested

Stated plainly, because a test plan that implies more coverage than it has is
worse than one that admits its edges. Functional gaps (as opposed to coverage
gaps) live in [LIMITATIONS.md](LIMITATIONS.md):

- **The real Gemini path.** By design — non-deterministic, and needs a key.
- **Load and backpressure.** No test opens 100 threads or a slow consumer.
- **Multi-instance behaviour.** The hub is single-process; nothing tests fan-out.
- **Visual regression.** No screenshot comparison; layout changes are unguarded.
- **Mobile viewports.** The CSS is responsive but only desktop sizes are run.

## Testing replay and resync by hand

Recovery only happens when the replay buffer overflows, which on the default
500-event buffer takes about twenty-five prompts. That impracticality is the
direct cause of three shipped bugs, so there is a dev mode for it:

```bash
pnpm dev:recovery      # server on :3002 with a 40-event buffer, web on :5174
```

### How much survives, and why

The buffer holds a fixed number of *events*, not threads, so what a reload can
restore depends on what a thread costs. That is not a constant &mdash; it falls
out of the agent's shape:

```
events = 5 + 4T + ceil(W / 3)

  5          thread.created, running, streaming, message.complete, and the
             terminal status: every thread pays these
  4 per tool call.call, awaiting_tool, tool.result, running
  W / 3      one message.delta per three words (ScriptedLlm's wordsPerChunk)
```

The order-tracking prompt is the expensive one, and the number the table below
uses:

| Thread | Tools | Words | Events |
|---|---|---|---|
| "Where is my order, can you track shipping?" | 3 (transfer, lookupOrder, checkShippingStatus) | 17 | **23** |
| "What is your warranty coverage?" | 2 (transfer, searchKnowledgeBase) | 17 | 19 |
| "hello there" | 0 | 15 | 10 |
| Research pipeline | 2, across three agents | 3 messages | 42 |

So the retained window is somewhere between roughly `buffer / 42` and
`buffer / 10` threads depending on what you ask. Using 23:

| `SSE_REPLAY_BUFFER` | threads it holds | after 6 threads, a reload restores |
|---|---|---|
| 40 (`dev:recovery` default) | ~1.7 | 1 full, 1 partial, 4 unavailable |
| 100 | ~4.3 | 4 full, 1 partial, 1 unavailable |
| 500 (`dev` default) | ~21 | all 6 full |
| 500, after 25 threads | ~21 | 21 full, 1 partial, 3 unavailable |

(Measured with the order-tracking prompt throughout. A mixed session retains
more threads, because most cost fewer than 23 events.)

### What changes with real Gemini

The formula's *shape* survives, but only one of its three terms is ours:

| Term | Scripted | `MODEL_MODE=gemini` |
|---|---|---|
| **5** fixed | structural | **unchanged** — the adapter and runner emit these regardless of model |
| **4T** | scripted, 0&ndash;3 | same four events per round trip, but `T` is the *model's* choice. Bounded only by `maxLlmCalls: 20`, so the worst case is ~5 + 76 + D |
| **D** deltas | `ceil(W / 3)` | **not predictable.** ADK yields one `partial` per non-empty text delta the API streams (`interactions_utils.ts`), so `D` is Gemini's server-side chunking, one-to-one |

`wordsPerChunk: 3` is a `ScriptedLlm` parameter. It approximates streaming for
testing; it is not a prediction of how Gemini chunks. So `D` &mdash; and with it
the events per thread &mdash; **has to be measured, not derived**.

The instrumentation for that already exists: `lastSeq` in the snapshot *is* the
event count for a thread.

```bash
MODEL_MODE=gemini GOOGLE_API_KEY=... pnpm dev
# run a representative set of prompts, then:
curl -s 'http://localhost:3001/api/threads?sessionId=S' \
  | jq '[.threads[].lastSeq] | {threads: length, min: min, max: max, avg: (add/length)}'
```

Two things follow, and neither has been checked here because it needs a key:

- **`SSE_REPLAY_BUFFER: 500` was sized against scripted behaviour.** If Gemini
  emits several times as many deltas per answer, the readable window shrinks by
  the same factor and the default is wrong for production.
- **`maxLlmCalls: 20` is the only bound on `T`.** A model that loops through
  tools costs 4 events per round trip, so a single runaway thread can consume
  ~80 buffer slots on its own.

So on `dev:recovery` only the last two threads keep their content, and that
stays true as you add more — the window slides. That is the buffer working, not
a fault. Dial it to taste:

```bash
SSE_REPLAY_BUFFER=120 pnpm dev:recovery   # ~5 threads retained
```

The steady state it produces — a feed that grows without bound while only its
tail is readable — is a real design limitation rather than a testing artefact.
It is [L16](LIMITATIONS.md#l16).

### The recipe

Forty events is under two threads' worth, so:

1. Open `http://localhost:5174/?debug` — the `?debug` flag reveals the counters.
2. Send two prompts and let both finish. The buffer has now rolled.
3. **Reload.** That is the whole test.

What should happen, and what each failure mode looked like:

| Observation | Meaning |
|---|---|
| The **second** thread still shows its answer | The replay was applied. If it is empty and says its messages are unavailable, the snapshot is being treated as a watermark again |
| The **first** thread says *"Earlier messages … were lost"* | Correct: its start genuinely rolled out |
| `resyncs 1`, and it stays at 1 | Recovery settled. A climbing number is the reconnect loop |
| `lossy 0` after things settle | Nothing was discarded unrecoverably |
| A newly sent thread streams normally | The stream stayed up. Empty new threads were the loop's visible symptom |

The counters come from `FeedState.stats`, which has always tracked them —
nothing displayed them, which is why these bugs had to be diagnosed by reading
network frames instead of looking at the screen.

To watch the wire directly:

```bash
curl -N 'http://localhost:3002/api/stream?sessionId=S'          # fresh connect
curl -s 'http://localhost:3002/api/threads?sessionId=S' | jq    # the snapshot
```

### The gap that produced a bug, and the tests that closed it

Nothing used to exercise a replay-buffer overrun — the default 500-event buffer
is never reached in normal use — which is why [L1](LIMITATIONS.md#l1) survived
so long. The fix is covered at three layers, deliberately, because the bug lived
in the *seam* between them and any single layer would have passed while the
feature stayed broken:

| Layer | File | What it proves |
|---|---|---|
| Server | `apps/server/src/stream.test.ts` | With a tiny `replayBufferSize`, an unreachable resume point emits `event: resync`; resuming at `from - 1` stops it repeating; `GET /api/threads` carries each thread's `lastSeq` |
| Reducer | `apps/web/src/feed/reducer.test.ts` | A `resync` rebuilds missing threads *without* a watermark, so a replay that still holds the thread restores it whole |
| Hook | `apps/web/src/feed/useFeedStream.test.ts` | The frame triggers a snapshot fetch and exactly one reconnect, at the named offset |
| **Browser** | `e2e/specs/recovery.spec.ts` | All of the above, through the real stack, against a 40-event buffer |

The fourth row was added last and matters most. The first three passed while the
feature was broken three separate times, because each layer was correct in
isolation and the bug lived between them. Reintroducing any of the three
historical bugs now turns the browser project red.

Run just that layer with:

```bash
pnpm exec playwright test --project=recovery
```
