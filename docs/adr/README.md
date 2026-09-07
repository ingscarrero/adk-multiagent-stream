# Architecture decision records

Decisions with lasting consequences, each with the context it was made in and
the alternatives it beat. Most were made on the initial build and extracted
here from the README and the streaming contract; the resync and provider-seam
decisions came from later pull requests.

Format: [MADR](https://adr.github.io/madr/)-lite. Status is *accepted* unless
superseded. New decisions get the next number and a date.

| # | Decision | Date |
|---|---|---|
| [0001](0001-one-multiplexed-sse-connection.md) | One multiplexed SSE connection carries every thread | 2026-08-31 |
| [0002](0002-two-counters-seq-and-offset.md) | Two counters: per-thread `seq` for ordering, per-session `offset` for resume | 2026-08-31 |
| [0003](0003-deterministic-scripted-model.md) | Every test runs against a deterministic scripted model | 2026-08-31 |
| [0004](0004-adk-confined-to-the-server.md) | ADK is confined to the server; the client and the protocol are framework-free | 2026-08-31 |
| [0005](0005-substrate-behind-ports.md) | Substrate sits behind ports with emulated defaults; storage and delivery are one port | 2026-08-31 |
| [0006](0006-event-log-is-not-the-message-store.md) | The event log is not the message store; recovery rebuilds from a snapshot, not a watermark | 2026-08-31 |
