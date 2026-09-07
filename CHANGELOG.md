# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does not
yet cut tagged releases, so entries are grouped by the pull request that landed
them. Limitation ids (`L1`…`L17`) refer to [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## [Unreleased]

### Added
- MIT `LICENSE`, `license` fields in every workspace manifest.
- Coverage: `@vitest/coverage-v8`, an explicit `coverage.include` so untested
  files count, line/branch floors, a CI step that uploads the report, and a
  README badge.
- Unit tests for the presentational feed components (`ApprovalPrompt`,
  `MessageBubble`, `StatusChip`, `ThreadComposer`, `ToolStep`), the `App`
  shell, `useStickyScroll`, and `packages/agents` model resolution and tools.
- Mermaid diagrams in Markdown: a C4-style container diagram, a sequence
  diagram of the multiplexed stream, and the thread status machine.
- `docs/REQUIREMENTS.md`, `docs/SYSTEM_DESIGN.md`, `docs/adr/` (six ADRs),
  `CONTRIBUTING.md`, `SECURITY.md`, this changelog, and README badges.

### Changed
- README license line corrected from Apache-2.0 to MIT (the `@google/adk`
  dependency is Apache-2.0; this repository is not a fork of it).

## 0.1.0 — 2026-08-31

The initial build, landed as seven pull requests on one day.

### PR #7 — follow-up turns and a human-in-the-loop gate
- `POST /api/threads/:id/messages` continues a thread against its existing ADK
  session; `message.user` event; per-thread composer. Closes L4.
- `requestRefund` gates on `requireConfirmation` when the amount exceeds $50;
  `thread.input_required` event; `POST /api/threads/:id/respond`;
  `ApprovalPrompt` renders the arguments before approval. Closes L5.
- `awaiting_tool → awaiting_input` added to the status table; the terminal
  guarantee restated as "terminal, or a pause the client can answer".

### PR #6 — backpressure and hub eviction
- `SessionHub.writeTo` bounds a subscriber's `writableLength` at
  `SSE_MAX_BUFFERED_BYTES` and disconnects a stalled consumer. Closes L2.
- `HubRegistry` sweeps idle, unwatched sessions (`SESSION_IDLE_TTL_MS`,
  `SESSION_SWEEP_INTERVAL_MS`); the event-stream port gained `drop`. Closes L3.

### PR #5 — Stop reachable by hand
- `pnpm dev:demo` paces the scripted model so cancellation is observable by a
  person (L17). The default pacing is unchanged for tests.

### PR #4 — conversational-UX comparison
- Visual pages show the UX decisions instead of asserting them.

### PR #3 — docs aligned and verified against the code
- The "Prompt to Pixel" orientation page; every document audited against the
  implementation. The `resync` client half was found missing and closed (L1),
  and the combined drop counter split into `droppedRedundant` and
  `droppedLossy` (L13).
- The cancellation window widened in the browser suite instead of retrying
  into it.

### PR #2 — one `eventStream` port
- Storage, retention, replay and delivery moved behind a single port with an
  in-process adapter and a contract suite; `EVENT_RETENTION` replaces
  `SSE_REPLAY_BUFFER` (the old name is still honoured).

### PR #1 — provider ports
- `sessions`, `knowledge`, `identity` ports with emulated adapters;
  `GET /api/health` reports which adapter is live.

### Initial commit
- Multiplexed SSE feed for concurrent ADK agent threads: per-thread `seq`,
  per-session `offset`, the status machine, the pure reducer, `ScriptedLlm`,
  the router and research agent graphs, the TypeScript eval harness, and the
  Playwright suite across Chromium and Firefox.
