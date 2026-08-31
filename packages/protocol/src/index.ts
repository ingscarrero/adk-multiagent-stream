/**
 * `@feed/protocol` — the contract shared by server, browser, and tests.
 *
 * This package has no runtime dependencies beyond zod and imports nothing from
 * ADK. That is deliberate: the UI and its tests must be able to describe a
 * stream without pulling in an agent framework, and swapping ADK for something
 * else should touch exactly one file (`apps/server/src/adk-adapter.ts`).
 */
export * from './events.ts';
export * from './status.ts';

/** The SSE `event:` name every feed frame is published under. */
export const SSE_EVENT_NAME = 'feed';

/**
 * The SSE `event:` name for a replay-buffer overrun notice.
 *
 * A separate event name rather than a `FeedEvent` variant, because it is a
 * transport-level condition about the connection, not something that happened
 * to a thread -- it carries no `threadId` and no `seq`.
 */
export const SSE_RESYNC_EVENT_NAME = 'resync';

/** Interval hint for the client's stall detector; server heartbeats faster than this. */
export const SSE_STALL_TIMEOUT_MS = 45_000;
