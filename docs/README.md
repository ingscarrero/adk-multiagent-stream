# Documentation

## Reference documents

| | |
|---|---|
| **[STREAMING-CONTRACT.md](STREAMING-CONTRACT.md)** | The protocol. Ordering, reconnect, the status machine, and the reasoning behind each. **Start here.** |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How the pieces fit, and the ADK behaviours worth knowing before reading the code. |
| **[TESTING.md](TESTING.md)** | The four test layers, why the suite isn't flaky, and what isn't covered. |
| **[LIMITATIONS.md](LIMITATIONS.md)** | Every known gap and follow-up, with cause, blast radius, and fix. |
| **[PROVIDERS.md](PROVIDERS.md)** | What is emulated versus what a real provider would serve, and where each seam is. |

## Visual deep-dives

Long-form pages for mechanisms that a diagram explains faster than prose. Open
them straight from the filesystem — each is one self-contained HTML file with no
build step, no bundler, and no assets beyond a Google Fonts link.

One overview, then one page per load-bearing file. Each opens with the mechanism, then the details
that are easy to get wrong, then a short set of trace-it-yourself questions.
Every page links to the other five, so the set reads in any order.

| Page | File it explains |
|---|---|
| **[visual/architecture.html](visual/architecture.html)**<br>*The Substrate Line* | the system as a whole — the two rules that shape it, and the line between logic this repo implements and infrastructure it stands in for. **Start here.** |
| **[visual/reducer-gates.html](visual/reducer-gates.html)**<br>*Four Gates and a Drain* | `apps/web/src/feed/reducer.ts` — the three outcomes, the four gates, the drain loop, eight worked traces including resync recovery |
| **[visual/adk-adapter.html](visual/adk-adapter.html)**<br>*Many Authors, One Feed* | `apps/server/src/adk-adapter.ts` — the ADK seam, the per-author Map, translation order, who owns status |
| **[visual/sse-hub.html](visual/sse-hub.html)**<br>*One Wire, Many Threads* | `apps/server/src/sse.ts` — multiplexing, the two counters, the priming frame, and the resync exchange frame by frame |
| **[visual/thread-runner.html](visual/thread-runner.html)**<br>*Start, Stream, Settle* | `apps/server/src/thread-runner.ts` — detached runs, single-point sequencing, the terminal guarantee, the resync snapshot |
| **[visual/scripted-llm.html](visual/scripted-llm.html)**<br>*A Model That Never Changes Its Mind* | `packages/agents/src/scripted-llm.ts` — determinism, turn recovery, three ADK traps |

---

## Conventions

**Where a thing goes.** Prose that a reader follows top to bottom is Markdown in
`docs/`. A mechanism whose shape is the explanation — a state machine, a flow
through gates, a sequence evolving over time — earns a page in `docs/visual/`.
If a sentence says it faster, write the sentence.

**One claim, one home.** A document describes only behaviour that is implemented
and tested. Anything partial, planned, or cut is recorded in
[LIMITATIONS.md](LIMITATIONS.md) and linked from wherever a reader would
otherwise assume it works.

This convention exists because it was violated: two documents and two source
comments once asserted that a `resync` mechanism worked end to end when only its
server half had been built. Nothing was lying on purpose — the docs were written
alongside the server and never revisited when the client half didn't land. That
is exactly how it happens.

**Limitations get stable ids.** `L1`, `L2`, and so on, so code comments and
other documents can cite one (`see L1 in docs/LIMITATIONS.md`) and the reference
survives the list being reordered.

**Visual pages carry their own theme.** Light and dark are both defined with CSS
custom properties, and diagrams are hand-authored inline SVG using those tokens
— no diagramming library, no generated images, no binary assets in review. Every
`<svg>` carries an `aria-label` stating what it shows, because a diagram that
only works visually documents the mechanism for some readers and not others.

**Each page is self-contained, and the duplicated CSS is deliberate.** The five
pages share a palette and type scale by copy, not by a shared stylesheet. That
way any one of them can be opened straight from disk, emailed, or published as a
standalone artifact with no assets to carry. The cost is that a palette change
touches five files; the benefit is that a page is never half-broken because
something next to it moved.

**Pages go stale; the code does not.** Each page says so in its own footer. Where
a page and the source disagree, the source is right — these explain mechanisms
and reasoning, they are not a second source of truth for behaviour.

**Line references are allowed to go stale.** Deep-dives cite `file.ts:123` to
get you to the right place quickly. Treat them as approximate; the symbol names
they mention are the durable part.
