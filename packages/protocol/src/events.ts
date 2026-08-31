/**
 * The wire protocol between server and browser.
 *
 * One discriminated union, one zod schema, shared by both sides. The server
 * validates on the way out (so a malformed event fails in a test, not in the
 * UI); the client validates on the way in (so a version-skewed server can't
 * corrupt the reducer's state).
 *
 * ## The two invariants everything else rests on
 *
 * 1. **`threadId`** — every event names its thread. A single SSE connection
 *    multiplexes all threads, so this is what demultiplexes them.
 * 2. **`seq`** — a per-thread monotonic counter assigned by the server, starting
 *    at 1. Gaps mean loss, repeats mean replay. This is what makes ordering an
 *    assertion rather than a hope.
 *
 * `seq` is per-thread and NOT global: two threads streaming concurrently both
 * emit seq 1, 2, 3… Ordering is only ever defined *within* a thread, which is
 * the only place it actually matters.
 *
 * @see docs/STREAMING-CONTRACT.md
 */

import { z } from 'zod';
import { THREAD_STATUSES } from './status.ts';

export const threadStatusSchema = z.enum(THREAD_STATUSES);

/** Fields carried by every event, regardless of kind. */
const envelope = {
  /** Which thread this event belongs to. */
  threadId: z.string().min(1),
  /** Per-thread monotonic sequence number, starting at 1. */
  seq: z.number().int().positive(),
  /** Server wall-clock time (ms since epoch) at emit. Display only — never ordering. */
  ts: z.number().int().nonnegative(),
};

/**
 * A thread has been accepted. Always seq 1, always the first event for a thread.
 * Emitted synchronously from POST /api/threads so the UI can render the thread
 * before the model produces anything.
 */
export const threadCreatedSchema = z.object({
  type: z.literal('thread.created'),
  ...envelope,
  /** The user's prompt, echoed back so late subscribers can render the thread. */
  prompt: z.string(),
  /** Which agent this thread was routed to at creation. */
  agent: z.string(),
});

/**
 * A message the *user* sent into an existing thread.
 *
 * `thread.created` already carries the opening prompt, so this is only ever a
 * follow-up -- the second turn onward. Keeping them as separate types means a
 * reader never has to ask which of two user messages started the thread, and
 * the reducer can place a follow-up in the timeline without re-deriving it.
 */
export const messageUserSchema = z.object({
  type: z.literal('message.user'),
  ...envelope,
  text: z.string(),
});

/** An incremental chunk of model text. Append-only: never re-sends prior text. */
export const messageDeltaSchema = z.object({
  type: z.literal('message.delta'),
  ...envelope,
  /** Stable id of the message being built. Deltas accumulate into it. */
  messageId: z.string().min(1),
  /** Agent that authored this text — distinguishes sub-agents in one thread. */
  author: z.string(),
  /** The new text to append. */
  delta: z.string(),
});

/**
 * A message is finished. Carries the full text so the client can *replace*
 * rather than trust its accumulation — the cheap self-healing property that
 * makes a dropped delta a cosmetic flicker instead of a corrupted message.
 */
export const messageCompleteSchema = z.object({
  type: z.literal('message.complete'),
  ...envelope,
  messageId: z.string().min(1),
  author: z.string(),
  /** The authoritative full text of the message. */
  text: z.string(),
});

/** The agent invoked a tool. Renders as a collapsed step in the thread. */
export const toolCallSchema = z.object({
  type: z.literal('tool.call'),
  ...envelope,
  /** Correlates with the matching tool.result. */
  callId: z.string().min(1),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});

/** A tool returned. Correlates to its call by `callId`. */
export const toolResultSchema = z.object({
  type: z.literal('tool.result'),
  ...envelope,
  callId: z.string().min(1),
  name: z.string(),
  result: z.unknown(),
  /** Wall-clock duration of the tool call, for the UI's timing hint. */
  durationMs: z.number().int().nonnegative().optional(),
});

/** The thread moved to a new lifecycle state. */
export const threadStatusEventSchema = z.object({
  type: z.literal('thread.status'),
  ...envelope,
  status: threadStatusSchema,
});

/**
 * The run is paused on a human decision.
 *
 * Emitted alongside the `awaiting_input` status, and carrying what that status
 * cannot: *what* is being asked. A status alone tells the UI to stop showing a
 * spinner; it does not tell it what to render instead, or what to send back.
 *
 * `requestId` is ADK's `interruptId`, and answering means quoting it back --
 * see `POST /api/threads/:id/respond`. It is opaque to the client on purpose:
 * the client's job is to relay a decision, not to understand ADK's interrupt
 * encoding.
 */
export const threadInputRequiredSchema = z.object({
  type: z.literal('thread.input_required'),
  ...envelope,
  /** ADK's interrupt id. Quote it back to answer. */
  requestId: z.string().min(1),
  /** What is being asked for. Only `confirmation` is reachable today. */
  kind: z.enum(['confirmation', 'credential', 'input']),
  /** The tool awaiting approval, when the request is a confirmation. */
  toolName: z.string().optional(),
  /** The arguments that tool would run with, so the user can judge the request. */
  toolArgs: z.record(z.string(), z.unknown()).optional(),
  /** Human-readable prompt, when the raiser supplied one. */
  prompt: z.string().optional(),
});

/** Terminal failure. Always followed by no further events for this thread. */
export const threadErrorSchema = z.object({
  type: z.literal('thread.error'),
  ...envelope,
  message: z.string(),
  /** ADK's `errorCode` when the failure came from the model layer. */
  code: z.string().optional(),
});

export const feedEventSchema = z.discriminatedUnion('type', [
  threadCreatedSchema,
  messageUserSchema,
  threadInputRequiredSchema,
  messageDeltaSchema,
  messageCompleteSchema,
  toolCallSchema,
  toolResultSchema,
  threadStatusEventSchema,
  threadErrorSchema,
]);

export type FeedEvent = z.infer<typeof feedEventSchema>;
export type FeedEventType = FeedEvent['type'];

/** Narrowing helper: `FeedEventOf<'message.delta'>` is the delta variant alone. */
export type FeedEventOf<T extends FeedEventType> = Extract<FeedEvent, { type: T }>;

export type ThreadCreatedEvent = FeedEventOf<'thread.created'>;
export type MessageUserEvent = FeedEventOf<'message.user'>;
export type ThreadInputRequiredEvent = FeedEventOf<'thread.input_required'>;
export type MessageDeltaEvent = FeedEventOf<'message.delta'>;
export type MessageCompleteEvent = FeedEventOf<'message.complete'>;
export type ToolCallEvent = FeedEventOf<'tool.call'>;
export type ToolResultEvent = FeedEventOf<'tool.result'>;
export type ThreadStatusEvent = FeedEventOf<'thread.status'>;
export type ThreadErrorEvent = FeedEventOf<'thread.error'>;

/**
 * Whether an event belongs in the durable transcript.
 *
 * Everything except `message.delta`. A delta exists to show text before it is
 * finished; once `message.complete` lands carrying the authoritative full text,
 * the chunks that built it are worth nothing. Storing settled events only is
 * about five writes per turn rather than twenty-three, and loses nothing a
 * reader would ever ask for.
 *
 * Lives here rather than in the store so the server, the store and any future
 * adapter cannot disagree about what durable means.
 */
export function isDurableEvent(event: FeedEvent): boolean {
  return event.type !== 'message.delta';
}

/** Parses an untrusted payload into a FeedEvent, or throws. */
export function parseFeedEvent(input: unknown): FeedEvent {
  return feedEventSchema.parse(input);
}

/** Parses without throwing — the client path, where one bad frame must not kill the stream. */
export function safeParseFeedEvent(input: unknown): FeedEvent | null {
  const result = feedEventSchema.safeParse(input);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

/** Body of `POST /api/threads`. */
export const createThreadRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  /** Which agent entrypoint to run. Defaults to the router on the server. */
  agent: z.string().optional(),
});

export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

/**
 * Body of `POST /api/threads/:id/messages` -- a follow-up in an existing thread.
 *
 * No `agent` field: a follow-up continues the conversation it is part of, and
 * re-routing mid-thread would make the transcript incoherent.
 */
export const followUpRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
});

export type FollowUpRequest = z.infer<typeof followUpRequestSchema>;

/**
 * Body of `POST /api/threads/:id/respond` -- answering a paused run.
 *
 * `requestId` is required rather than implied by the thread, so a stale
 * approval cannot resolve a *different* request that happens to be pending by
 * the time it lands. The server rejects a mismatch instead of guessing.
 */
export const inputResponseRequestSchema = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
});

export type InputResponseRequest = z.infer<typeof inputResponseRequestSchema>;

/**
 * A thread as the server currently knows it, without its transcript.
 *
 * Returned by `GET /api/threads` and used to rebuild client state after a
 * replay-buffer overrun. `lastSeq` is the crucial field: it tells a recovering
 * client where the thread's sequence has reached, so live events continue
 * contiguously instead of looking like an unbridgeable gap.
 *
 * `transcript` is the thread's settled events, from the durable message store:
 * everything except `message.delta`, which is a transport artefact worth
 * nothing once the message it built has closed. It used to be absent, because
 * events lived only in the bounded replay window and there was nothing to
 * return -- see L7 for the conflation that caused, and docs/ARCHITECTURE.md for
 * why a log and a transcript are different jobs.
 */
export const threadSummarySchema = z.object({
  id: z.string(),
  prompt: z.string(),
  agent: z.string(),
  status: threadStatusSchema,
  createdAt: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  /**
   * The thread's settled events, oldest first.
   *
   * Empty for a thread the store has nothing for, which after a restart with
   * the memory adapter is every thread -- the honest failure mode of an
   * emulated store, and exactly what the Postgres adapter fixes.
   */
  transcript: z.array(feedEventSchema).default([]),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** Response of `GET /api/threads`. */
export const threadsSnapshotSchema = z.object({
  threads: z.array(threadSummarySchema),
});

export type ThreadsSnapshot = z.infer<typeof threadsSnapshotSchema>;

/**
 * Payload of the SSE `resync` frame.
 *
 * Sent when a reconnecting client asks to resume from an offset the buffer no
 * longer holds. `from` is the oldest offset still available, which is what the
 * client cannot bridge on its own.
 */
export const resyncNoticeSchema = z.object({
  from: z.number().int().positive(),
});

export type ResyncNotice = z.infer<typeof resyncNoticeSchema>;

export function safeParseResyncNotice(input: unknown): ResyncNotice | null {
  const result = resyncNoticeSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Response of `POST /api/threads`. Returns immediately; work happens on the stream. */
export const createThreadResponseSchema = z.object({
  threadId: z.string(),
  sessionId: z.string(),
});

export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
