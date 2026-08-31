/**
 * The feed reducer: a pure function from (state, FeedEvent) to state.
 *
 * Everything hard about a streaming multi-thread UI lives here, and nothing
 * about React does. That separation is the point — the ordering rules below are
 * tested as data-in/data-out, with no renderer, no timers, and no network.
 *
 * ## The three rules
 *
 * 1. **In-order application.** An event is applied only when its `seq` is
 *    exactly one past the thread's last applied seq.
 * 2. **Buffer ahead, drop behind.** A higher `seq` is held until its
 *    predecessors arrive; a `seq` already applied is a replay and is dropped.
 *    Both happen for real: SSE reconnect replays, and nothing guarantees a
 *    proxy delivers frames in order across a reconnect boundary.
 * 3. **Complete replaces, delta appends.** `message.complete` carries the
 *    authoritative full text, so a dropped delta self-heals into a flicker
 *    rather than a permanently corrupted message.
 *
 * ## Two kinds of drop
 *
 * Three code paths below discard an event, and they mean opposite things:
 *
 * - **Redundant** (already applied, or already buffered) — the information is
 *   already in state, so discarding the copy is the correct outcome. These are
 *   what make the reducer idempotent, and a burst is expected after every
 *   reconnect.
 * - **Lossy** (unknown thread) — the information is destroyed and will not be
 *   re-sent. Every one is a hole in the feed.
 *
 * They are counted separately (`droppedRedundant` / `droppedLossy`) precisely
 * so the two can be told apart: a burst of redundant drops is a healthy
 * reconnect, while a single lossy drop means the feed is missing something.
 *
 * ## Recovery
 *
 * A lossy drop is not always terminal. When the server reports that a client's
 * resume point has fallen out of its replay buffer, the client fetches
 * `GET /api/threads` and dispatches a `resync` action, which rebuilds the
 * missing threads from that snapshot. Threads restored this way carry
 * `historyTruncated`, because their transcript is genuinely unrecoverable.
 *
 * @see docs/STREAMING-CONTRACT.md
 */

import {
  canTransition,
  isTerminal,
  type FeedEvent,
  type ThreadStatus,
  type ThreadSummary,
} from '@feed/protocol';

export interface Message {
  id: string;
  author: string;
  text: string;
  /** False while deltas are still arriving — drives the streaming caret. */
  streaming: boolean;
}

export interface ToolInvocation {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  state: 'pending' | 'done';
}

/** An ordered reference into `messages` or `tools`, in arrival order. */
export type TimelineItem =
  | { kind: 'message'; id: string }
  | { kind: 'tool'; callId: string }
  /**
   * A follow-up the user typed. Carried inline rather than by reference,
   * because unlike a message or a tool call it is never updated after arrival
   * -- there is no second event to correlate with.
   */
  | { kind: 'user'; text: string; at: number };

export interface ThreadState {
  id: string;
  prompt: string;
  agent: string;
  status: ThreadStatus;
  error?: { message: string; code?: string };
  timeline: TimelineItem[];
  messages: Record<string, Message>;
  tools: Record<string, ToolInvocation>;
  createdAt: number;
  updatedAt: number;
  /** Highest contiguously-applied seq. */
  lastSeq: number;
  /** Events held back because they arrived ahead of their predecessors. */
  buffered: FeedEvent[];
  /**
   * True when part of this thread's history was lost and rebuilt from a
   * snapshot. The transcript is incomplete and the UI must say so rather than
   * present a partial thread as whole.
   */
  historyTruncated: boolean;
  /**
   * The human decision this thread is blocked on, when it is blocked.
   *
   * Present exactly while `status === 'awaiting_input'`. Cleared when the run
   * resumes, so the approval control cannot outlive the request it answers --
   * which would let a user approve something twice.
   */
  inputRequest?: {
    requestId: string;
    kind: 'confirmation' | 'credential' | 'input';
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    prompt?: string;
  };
  /**
   * Set by a resync: the next event for this thread may skip ahead of
   * `lastSeq`, and should be accepted rather than buffered against a gap.
   *
   * After a resync the client cannot know how much of the thread the server is
   * about to replay -- possibly all of it, possibly none. So it does not guess.
   * It waits for the first event and learns from its `seq` whether anything was
   * actually missed.
   */
  awaitingResume: boolean;
  /**
   * Set alongside {@link awaitingResume} when the thread was rebuilt from a
   * durable transcript rather than from identity alone.
   *
   * It exists to keep two things apart that `timeline.length` conflates: a
   * thread that has content because the *store* returned it, and one that has
   * content because it was here all along. Only the first makes a forward jump
   * expected -- the transcript stores settled events, so the seq numbers that
   * belonged to deltas are legitimately absent. For the second, a jump still
   * means loss.
   */
  restoredFromStore: boolean;
}

export interface FeedState {
  threads: Record<string, ThreadState>;
  /**
   * Render order, oldest first.
   *
   * Chat convention: new threads append at the bottom and the view follows
   * them down. The alternative (newest at top) reads fine as a social feed but
   * fights the sticky-scroll behaviour, because "follow new content" and
   * "scroll to the bottom" then point in opposite directions.
   */
  order: string[];
  /**
   * Counters. Diagnostic, not decorative -- `droppedLossy` is the one that says
   * the feed is missing something, and it is the reason the two kinds of drop
   * are counted separately rather than summed.
   */
  stats: {
    applied: number;
    /** Dropped because the information was already in state. Healthy. */
    droppedRedundant: number;
    /** Dropped because the information was unusable and is now gone. A symptom. */
    droppedLossy: number;
    buffered: number;
    /** Times the server reported an unreachable resume point. */
    resyncs: number;
  };
}

export const initialFeedState: FeedState = {
  threads: {},
  order: [],
  stats: { applied: 0, droppedRedundant: 0, droppedLossy: 0, buffered: 0, resyncs: 0 },
};

/** Total drops, for display where the distinction does not matter. */
export function totalDropped(stats: FeedState['stats']): number {
  return stats.droppedRedundant + stats.droppedLossy;
}

/** Number of active (non-terminal) threads. Drives the header's live count. */
export function activeThreadCount(state: FeedState): number {
  return state.order.filter((id) => {
    const thread = state.threads[id];
    return thread !== undefined && !isTerminal(thread.status);
  }).length;
}

function createThread(event: Extract<FeedEvent, { type: 'thread.created' }>): ThreadState {
  return {
    id: event.threadId,
    prompt: event.prompt,
    agent: event.agent,
    status: 'queued',
    timeline: [],
    messages: {},
    tools: {},
    createdAt: event.ts,
    updatedAt: event.ts,
    lastSeq: 0,
    buffered: [],
    historyTruncated: false,
    awaitingResume: false,
    restoredFromStore: false,
  };
}

/**
 * Applies one event to one thread, assuming the ordering check already passed.
 * Returns a new ThreadState; never mutates the input.
 */
function applyToThread(thread: ThreadState, event: FeedEvent): ThreadState {
  const next: ThreadState = {
    ...thread,
    lastSeq: event.seq,
    updatedAt: event.ts,
    messages: { ...thread.messages },
    tools: { ...thread.tools },
    timeline: thread.timeline,
  };

  switch (event.type) {
    case 'thread.created':
      // Already handled by `createThread`; re-applying is a no-op.
      return next;

    case 'thread.status': {
      // The client tolerates an illegal transition (drops it) where the server
      // throws. A browser must survive a version-skewed or replayed stream.
      if (!canTransition(thread.status, event.status)) return next;
      // Leaving `awaiting_input` means the request was answered, so the control
      // goes with it. Keyed off the status rather than off the response landing,
      // because the status is the thing that is replayed on reconnect.
      if (thread.status === 'awaiting_input' && event.status !== 'awaiting_input') {
        const { inputRequest: _answered, ...rest } = next;
        return { ...rest, status: event.status };
      }
      return { ...next, status: event.status };
    }

    case 'message.user':
      next.timeline = [...thread.timeline, { kind: 'user', text: event.text, at: event.ts }];
      return next;

    case 'thread.input_required':
      return {
        ...next,
        inputRequest: {
          requestId: event.requestId,
          kind: event.kind,
          ...(event.toolName ? { toolName: event.toolName } : {}),
          ...(event.toolArgs ? { toolArgs: event.toolArgs } : {}),
          ...(event.prompt ? { prompt: event.prompt } : {}),
        },
      };

    case 'thread.error':
      return {
        ...next,
        error: { message: event.message, ...(event.code ? { code: event.code } : {}) },
      };

    case 'message.delta': {
      const existing = next.messages[event.messageId];
      next.messages[event.messageId] = existing
        ? { ...existing, text: existing.text + event.delta }
        : { id: event.messageId, author: event.author, text: event.delta, streaming: true };
      if (!existing) {
        next.timeline = [...thread.timeline, { kind: 'message', id: event.messageId }];
      }
      return next;
    }

    case 'message.complete': {
      const existing = next.messages[event.messageId];
      // Replace, never append: `text` is authoritative.
      next.messages[event.messageId] = {
        id: event.messageId,
        author: event.author,
        text: event.text,
        streaming: false,
      };
      if (!existing) {
        next.timeline = [...thread.timeline, { kind: 'message', id: event.messageId }];
      }
      return next;
    }

    case 'tool.call': {
      const existing = next.tools[event.callId];
      next.tools[event.callId] = {
        callId: event.callId,
        name: event.name,
        args: event.args,
        state: 'pending',
      };
      if (!existing) {
        next.timeline = [...thread.timeline, { kind: 'tool', callId: event.callId }];
      }
      return next;
    }

    case 'tool.result': {
      const existing = next.tools[event.callId];
      next.tools[event.callId] = {
        callId: event.callId,
        name: event.name,
        args: existing?.args ?? {},
        result: event.result,
        state: 'done',
      };
      if (!existing) {
        next.timeline = [...thread.timeline, { kind: 'tool', callId: event.callId }];
      }
      return next;
    }
  }
}

/**
 * Applies an event and then drains any buffered successors it unblocked.
 *
 * The drain loop is what makes out-of-order delivery invisible: once the gap
 * closes, everything queued behind it lands in one render.
 */
function applyWithDrain(
  thread: ThreadState,
  event: FeedEvent,
  stats: FeedState['stats'],
): ThreadState {
  let current = applyToThread(thread, event);
  stats.applied += 1;

  // Each applied event may unblock the next one, so keep draining until the
  // buffer holds nothing contiguous with what has been applied.
  while (current.buffered.length > 0) {
    const nextIndex = current.buffered.findIndex((held) => held.seq === current.lastSeq + 1);
    if (nextIndex === -1) break;

    const held = current.buffered[nextIndex]!;
    const remaining = current.buffered.filter((_, index) => index !== nextIndex);
    current = { ...applyToThread(current, held), buffered: remaining };
    stats.applied += 1;
  }

  return current;
}

/**
 * What the reducer accepts.
 *
 * `event` is the ordinary path: one frame off the stream. `resync` is the
 * recovery path, dispatched by the client after the server reports that its
 * resume point has fallen out of the replay buffer.
 *
 * Discriminated on `kind` rather than `type`, so it never collides with the
 * `type` field of a `FeedEvent`.
 */
export type FeedAction =
  | { kind: 'event'; event: FeedEvent }
  | { kind: 'resync'; threads: ThreadSummary[] };

/** Wraps a stream frame as an action. */
export const eventAction = (event: FeedEvent): FeedAction => ({ kind: 'event', event });

/** Wraps a `GET /api/threads` snapshot as an action. */
export const resyncAction = (threads: ThreadSummary[]): FeedAction => ({ kind: 'resync', threads });

/**
 * Rebuilds state from a server snapshot after a replay-buffer overrun.
 *
 * Threads we have never seen become shells so they are visible and their events
 * can land; threads we already have keep everything they have.
 *
 * ## What this deliberately does not do
 *
 * It does **not** move `lastSeq` forward to the snapshot's value. That looks
 * right -- the server says the thread has reached seq 40, so start there -- and
 * it silently destroys history: immediately after the snapshot the server
 * replays its whole buffer, which for a recent thread contains *every one of
 * its events*. With `lastSeq` already at 40, all of them fail the
 * already-applied gate and are discarded as redundant. The thread renders
 * empty, and says its messages are unavailable, while its entire transcript was
 * sitting in the replay it just threw away.
 *
 * Instead each thread is marked {@link ThreadState.awaitingResume}: the next
 * event may skip ahead, and whether it *actually* skipped is read from its
 * `seq` when it arrives. The client stops guessing what it missed and finds out.
 *
 * Local threads absent from the snapshot are kept: the server never forgets a
 * thread within a session, so their absence would mean the snapshot is wrong,
 * not that the thread is.
 */
function applyResync(state: FeedState, summaries: ThreadSummary[]): FeedState {
  const threads = { ...state.threads };
  const order = [...state.order];

  for (const summary of summaries) {
    const existing = threads[summary.id];

    const shell: ThreadState = existing ?? {
      id: summary.id,
      prompt: summary.prompt,
      agent: summary.agent,
      status: summary.status,
      timeline: [],
      messages: {},
      tools: {},
      createdAt: summary.createdAt,
      updatedAt: summary.createdAt,
      // Deliberately NOT the snapshot's lastSeq. See the note above.
      lastSeq: 0,
      buffered: [],
      historyTruncated: summary.lastSeq > 0,
      awaitingResume: true,
      restoredFromStore: false,
    };

    // Hydrate from the durable transcript, bypassing the ordering gates.
    //
    // A transcript has gaps *by design*: it stores settled events only, so the
    // seq numbers that belonged to deltas are simply absent. Feeding it through
    // gate 3 would read those holes as loss and buffer the whole thing against
    // predecessors that are never coming. The gates police a *transport*; a
    // store is not one.
    const hydrated = summary.transcript.reduce(applyToThread, shell);

    const restoredFromStore = summary.transcript.length > 0;
    threads[summary.id] = {
      ...hydrated,
      status: summary.status,
      // The store answered, so nothing is missing. History is only genuinely
      // gone when the thread has no content from either source -- which with
      // the memory adapter is exactly what a restart looks like.
      historyTruncated: hydrated.timeline.length === 0 && summary.lastSeq > 0,
      lastSeq: summary.transcript.at(-1)?.seq ?? shell.lastSeq,
      awaitingResume: true,
      restoredFromStore,
    };
    if (!existing) order.push(summary.id);
  }

  return {
    threads,
    // Keep the feed in creation order, which is how it was rendered before.
    order: order.sort((a, b) => (threads[a]?.createdAt ?? 0) - (threads[b]?.createdAt ?? 0)),
    stats: { ...state.stats, resyncs: state.stats.resyncs + 1 },
  };
}

function reduceEvent(state: FeedState, event: FeedEvent): FeedState {
  const stats = { ...state.stats };
  const existing = state.threads[event.threadId];

  // A thread we have never seen must open with `thread.created` (seq 1). Any
  // other first event means we joined mid-stream without a replay, so we drop
  // it rather than render a thread with no prompt and no provenance.
  if (!existing) {
    if (event.type !== 'thread.created') {
      // LOSSY drop: this content is gone for good -- the server does not
      // re-send on request. Counted separately because, unlike a redundant
      // drop, a single one of these means the feed is missing something. The
      // recovery path is a `resync` action, driven by the server's overrun
      // notice; until one arrives this branch keeps firing for the thread.
      stats.droppedLossy += 1;
      return { ...state, stats };
    }
    const thread = applyToThread(createThread(event), event);
    return {
      threads: { ...state.threads, [thread.id]: thread },
      order: [...state.order, thread.id],
      stats: { ...stats, applied: stats.applied + 1 },
    };
  }

  // Replay of something already applied.
  if (event.seq <= existing.lastSeq) {
    // REDUNDANT drop: already folded into state. This is the line that makes
    // the whole reducer idempotent, and a burst of these is the expected shape
    // of a healthy reconnect.
    stats.droppedRedundant += 1;
    return { ...state, stats };
  }

  // First event after a resync: accept it wherever it lands.
  //
  // The client does not know how much of this thread the server is about to
  // replay, so it does not assume. Whether anything was actually missed is read
  // from this event's `seq`: arriving at 1 means the whole thread is coming and
  // nothing was lost; arriving above `lastSeq + 1` means a prefix is gone.
  if (existing.awaitingResume) {
    const jumped = event.seq > existing.lastSeq + 1;
    const resumed: ThreadState = {
      ...existing,
      // Line the thread up so this event applies contiguously.
      lastSeq: event.seq - 1,
      awaitingResume: false,
      // seq 1 is the start of the thread by definition, so nothing precedes it.
      //
      // A jump only means loss when there is nothing to compare it against.
      // After hydrating from a transcript the thread already holds its content
      // and the gap is the delta seqs the store deliberately never kept, so
      // reading it as truncation would slander a complete transcript.
      historyTruncated:
        event.seq === 1
          ? false
          : existing.restoredFromStore
            ? existing.historyTruncated
            : existing.historyTruncated || jumped,
      restoredFromStore: false,
      // Anything held at or below this event is now redundant.
      buffered: existing.buffered.filter((held) => held.seq > event.seq),
    };
    const updated = applyWithDrain(resumed, event, stats);
    return { ...state, threads: { ...state.threads, [updated.id]: updated }, stats };
  }

  // Arrived early: hold it until the gap closes.
  if (event.seq > existing.lastSeq + 1) {
    if (existing.buffered.some((held) => held.seq === event.seq)) {
      // REDUNDANT drop: a copy is already held. The gate above cannot catch
      // this one, because a buffered event has not advanced `lastSeq`.
      stats.droppedRedundant += 1;
      return { ...state, stats };
    }
    stats.buffered += 1;
    return {
      ...state,
      threads: {
        ...state.threads,
        [existing.id]: { ...existing, buffered: [...existing.buffered, event] },
      },
      stats,
    };
  }

  const updated = applyWithDrain(existing, event, stats);
  return {
    ...state,
    threads: { ...state.threads, [updated.id]: updated },
    stats,
  };
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.kind) {
    case 'event':
      return reduceEvent(state, action.event);
    case 'resync':
      return applyResync(state, action.threads);
  }
}

/** Folds a batch of events. Convenience for tests and for replay on mount. */
export function reduceAll(state: FeedState, events: FeedEvent[]): FeedState {
  return events.reduce((current, event) => feedReducer(current, eventAction(event)), state);
}
