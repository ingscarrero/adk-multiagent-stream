/**
 * Reducer tests.
 *
 * These are the cheapest and highest-value tests in the repo: every ordering
 * hazard a real stream can produce is expressible as an array literal here, so
 * cases that would be flaky or impossible to trigger in a browser (a reordered
 * frame, a duplicate after reconnect, a gap that never closes) are ordinary
 * synchronous assertions.
 */
import { describe, expect, it } from 'vitest';
import type { FeedEvent, ThreadStatus } from '@feed/protocol';
import {
  activeThreadCount,
  eventAction,
  feedReducer,
  initialFeedState,
  reduceAll,
  resyncAction,
  totalDropped,
  type FeedState,
} from './reducer.ts';
import type { ThreadSummary } from '@feed/protocol';

const T = 'thr-1';
const ts = 1_700_000_000_000;
const at = (seq: number) => ({ threadId: T, seq, ts: ts + seq });

const created = (threadId = T, seq = 1): FeedEvent => ({
  type: 'thread.created',
  threadId,
  seq,
  ts: ts + seq,
  prompt: 'where is my order?',
  agent: 'router',
});
const status = (seq: number, s: ThreadStatus): FeedEvent => ({
  type: 'thread.status',
  ...at(seq),
  status: s,
});
const delta = (seq: number, text: string, messageId = 'm1', author = 'router'): FeedEvent => ({
  type: 'message.delta',
  ...at(seq),
  messageId,
  author,
  delta: text,
});
const complete = (seq: number, text: string, messageId = 'm1', author = 'router'): FeedEvent => ({
  type: 'message.complete',
  ...at(seq),
  messageId,
  author,
  text,
});

const thread = (state: FeedState, id = T) => state.threads[id]!;
const messageText = (state: FeedState, messageId = 'm1', id = T) =>
  thread(state, id).messages[messageId]?.text;

const userMessage = (seq: number, text: string): FeedEvent => ({
  type: 'message.user',
  ...at(seq),
  text,
});

const inputRequired = (seq: number, requestId: string): FeedEvent => ({
  type: 'thread.input_required',
  ...at(seq),
  requestId,
  kind: 'confirmation',
  toolName: 'requestRefund',
  toolArgs: { orderId: 'A-1001', amount: 129.99 },
});

describe('follow-up messages (L4)', () => {
  it('places the follow-up in the timeline between the turns it separates', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      complete(3, 'first answer'),
      status(4, 'complete'),
      userMessage(5, 'and when will it arrive?'),
      status(6, 'running'),
      complete(7, 'second answer', 'm2'),
      status(8, 'complete'),
    ]);

    // Order is the assertion: a follow-up rendered above the answer it prompted
    // makes the transcript read backwards.
    expect(thread(state).timeline).toEqual([
      { kind: 'message', id: 'm1' },
      { kind: 'user', text: 'and when will it arrive?', at: ts + 5 },
      { kind: 'message', id: 'm2' },
    ]);
  });

  it('keeps one thread across turns rather than starting another', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      status(3, 'complete'),
      userMessage(4, 'again please'),
      status(5, 'running'),
      status(6, 'complete'),
    ]);

    expect(Object.keys(state.threads)).toEqual([T]);
    expect(thread(state).status).toBe('complete');
  });

  it('re-opens a completed thread into running', () => {
    // The transition the status machine had to grow. Without it the client
    // drops the status and the thread renders as finished while it streams.
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      status(3, 'complete'),
      status(4, 'running'),
    ]);
    expect(thread(state).status).toBe('running');
  });

  it('does not re-open an errored thread', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      status(3, 'error'),
      status(4, 'running'),
    ]);
    expect(thread(state).status).toBe('error');
  });
});

describe('human-in-the-loop requests (L5)', () => {
  it('records what is being asked, so the UI can render a decision', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      inputRequired(3, 'req-1'),
      status(4, 'awaiting_input'),
    ]);

    expect(thread(state).inputRequest).toEqual({
      requestId: 'req-1',
      kind: 'confirmation',
      toolName: 'requestRefund',
      toolArgs: { orderId: 'A-1001', amount: 129.99 },
    });
    expect(thread(state).status).toBe('awaiting_input');
  });

  it('clears the request when the thread leaves awaiting_input', () => {
    // Keyed off the status rather than off the response landing, because the
    // status is what gets replayed on reconnect. A control that outlived its
    // request would let a user approve the same action twice.
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      inputRequired(3, 'req-1'),
      status(4, 'awaiting_input'),
      status(5, 'running'),
    ]);

    expect(thread(state).inputRequest).toBeUndefined();
    expect(thread(state).status).toBe('running');
  });

  it('survives a replay of the whole pause, ending in the same state', () => {
    // Replay is not a special case here: the events are idempotent, so a
    // reconnect that re-delivers the pause must not resurrect an answered
    // request or duplicate the timeline.
    const events = [
      created(),
      status(2, 'running'),
      inputRequired(3, 'req-1'),
      status(4, 'awaiting_input'),
    ];
    const once = reduceAll(initialFeedState, events);
    const twice = reduceAll(once, events);

    expect(twice.threads[T]?.inputRequest).toEqual(once.threads[T]?.inputRequest);
    expect(twice.threads[T]?.timeline).toEqual(once.threads[T]?.timeline);
  });
});

describe('thread creation', () => {
  it('creates a thread from thread.created and appends it to the feed', () => {
    const state = reduceAll(initialFeedState, [created('a'), created('b')]);
    // Oldest first: new threads append at the bottom, chat-style, which is the
    // direction the sticky auto-scroll follows.
    expect(state.order).toEqual(['a', 'b']);
    expect(state.threads['a']?.prompt).toBe('where is my order?');
  });

  it('drops events for an unknown thread rather than inventing one', () => {
    // Happens if a client joins mid-stream with no replay. A thread with no
    // prompt and no agent is worse than no thread at all.
    const state = feedReducer(initialFeedState, eventAction(delta(2, 'orphan')));
    expect(state.order).toEqual([]);
    expect(state.stats.droppedLossy).toBe(1);
  });
});

describe('in-order application', () => {
  it('applies a contiguous sequence and tracks lastSeq', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      status(3, 'streaming'),
      delta(4, 'Hello '),
      delta(5, 'world'),
      complete(6, 'Hello world'),
      status(7, 'complete'),
    ]);

    expect(thread(state).lastSeq).toBe(7);
    expect(thread(state).status).toBe('complete');
    expect(messageText(state)).toBe('Hello world');
    expect(thread(state).messages['m1']?.streaming).toBe(false);
  });
});

describe('out-of-order delivery', () => {
  it('buffers an event that arrives ahead of its predecessor', () => {
    const state = reduceAll(initialFeedState, [created(), delta(4, 'late')]);

    expect(thread(state).lastSeq).toBe(1);
    expect(thread(state).buffered).toHaveLength(1);
    expect(messageText(state)).toBeUndefined();
    expect(state.stats.buffered).toBe(1);
  });

  it('drains the buffer in order once the gap closes', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      delta(4, 'C'),
      delta(3, 'B'),
      delta(2, 'A'),
    ]);

    // Reassembled in seq order, not arrival order.
    expect(messageText(state)).toBe('ABC');
    expect(thread(state).lastSeq).toBe(4);
    expect(thread(state).buffered).toHaveLength(0);
  });

  it('leaves the buffer intact while a gap remains unfilled', () => {
    const state = reduceAll(initialFeedState, [created(), delta(3, 'B'), delta(5, 'D')]);
    expect(thread(state).lastSeq).toBe(1);
    expect(thread(state).buffered.map((e) => e.seq)).toEqual([3, 5]);
  });
});

describe('duplicates and replay', () => {
  it('drops an event whose seq was already applied', () => {
    // SSE reconnect replays from Last-Event-ID; overlap is expected, not an error.
    const state = reduceAll(initialFeedState, [
      created(),
      delta(2, 'A'),
      delta(2, 'A'),
      delta(2, 'A'),
    ]);
    expect(messageText(state)).toBe('A');
    expect(state.stats.droppedRedundant).toBe(2);
  });

  it('drops a duplicate of an event already sitting in the buffer', () => {
    const state = reduceAll(initialFeedState, [created(), delta(5, 'X'), delta(5, 'X')]);
    expect(thread(state).buffered).toHaveLength(1);
    // Redundant, not lossy: a copy is already held.
    expect(state.stats.droppedRedundant).toBe(1);
  });

  it('is idempotent when a whole stream is replayed', () => {
    const events = [created(), status(2, 'running'), delta(3, 'Hi'), complete(4, 'Hi'), status(5, 'complete')];
    const once = reduceAll(initialFeedState, events);
    const twice = reduceAll(once, events);

    expect(twice.threads).toEqual(once.threads);
    expect(twice.order).toEqual(once.order);
  });
});

describe('message assembly', () => {
  it('lets message.complete replace accumulated deltas, healing a dropped one', () => {
    // seq 3 never arrives; the client's text is wrong until the complete lands.
    const partial = reduceAll(initialFeedState, [created(), delta(2, 'Hel')]);
    expect(messageText(partial)).toBe('Hel');

    const healed = reduceAll(partial, [delta(3, 'lo wor'), complete(4, 'Hello world')]);
    expect(messageText(healed)).toBe('Hello world');
    expect(thread(healed).messages['m1']?.streaming).toBe(false);
  });

  it('keeps two concurrent authors in separate messages', () => {
    // The ParallelAgent case, end to end through the reducer.
    const state = reduceAll(initialFeedState, [
      created(),
      delta(2, 'Market says', 'm1', 'market'),
      delta(3, 'Docs say', 'm2', 'docs'),
      delta(4, ' fast', 'm1', 'market'),
      delta(5, ' returns', 'm2', 'docs'),
    ]);

    expect(messageText(state, 'm1')).toBe('Market says fast');
    expect(messageText(state, 'm2')).toBe('Docs say returns');
    expect(thread(state).timeline).toEqual([
      { kind: 'message', id: 'm1' },
      { kind: 'message', id: 'm2' },
    ]);
  });
});

describe('tools', () => {
  it('moves a tool from pending to done when its result arrives', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      { type: 'tool.call', ...at(2), callId: 'c1', name: 'lookupOrder', args: { orderId: 'A-1' } },
    ]);
    expect(thread(state).tools['c1']?.state).toBe('pending');

    const done = reduceAll(state, [
      { type: 'tool.result', ...at(3), callId: 'c1', name: 'lookupOrder', result: { found: true } },
    ]);
    expect(done.threads[T]?.tools['c1']).toMatchObject({
      state: 'done',
      // Args survive the result: the UI shows what was asked and what came back.
      args: { orderId: 'A-1' },
      result: { found: true },
    });
  });

  it('interleaves tools and messages on one timeline in arrival order', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      { type: 'tool.call', ...at(2), callId: 'c1', name: 'lookupOrder', args: {} },
      { type: 'tool.result', ...at(3), callId: 'c1', name: 'lookupOrder', result: {} },
      delta(4, 'Found it'),
    ]);
    expect(thread(state).timeline).toEqual([
      { kind: 'tool', callId: 'c1' },
      { kind: 'message', id: 'm1' },
    ]);
  });
});

describe('status handling', () => {
  it('ignores an illegal transition instead of throwing', () => {
    // The server throws on these; the browser must not. A version-skewed or
    // replayed stream should degrade, not crash the tab.
    const state = reduceAll(initialFeedState, [created(), status(2, 'running'), status(3, 'complete')]);
    const after = feedReducer(state, eventAction(status(4, 'streaming')));
    expect(after.threads[T]?.status).toBe('complete');
  });

  it('records an error without losing the transcript so far', () => {
    const state = reduceAll(initialFeedState, [
      created(),
      status(2, 'running'),
      delta(3, 'partial answer'),
      { type: 'thread.error', ...at(4), message: 'model exploded', code: 'BOOM' },
      status(5, 'error'),
    ]);

    expect(thread(state).error).toEqual({ message: 'model exploded', code: 'BOOM' });
    expect(thread(state).status).toBe('error');
    expect(messageText(state)).toBe('partial answer');
  });
});

describe('activeThreadCount', () => {
  it('counts only non-terminal threads', () => {
    const state = reduceAll(initialFeedState, [
      created('a', 1),
      { type: 'thread.status', threadId: 'a', seq: 2, ts: 1, status: 'running' },
      created('b', 1),
      { type: 'thread.status', threadId: 'b', seq: 2, ts: 1, status: 'running' },
      { type: 'thread.status', threadId: 'b', seq: 3, ts: 1, status: 'complete' },
    ]);
    expect(activeThreadCount(state)).toBe(1);
  });
});

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const before = reduceAll(initialFeedState, [created(), delta(2, 'Hi')]);
    const snapshot = structuredClone(before);
    feedReducer(before, eventAction(delta(3, ' there')));
    expect(before).toEqual(snapshot);
  });
});

describe('discriminated drops (L13)', () => {
  it('counts a replay as redundant, not lossy', () => {
    // The healthy case. A burst of these is the expected shape of a reconnect
    // and must never look like data loss.
    const state = reduceAll(initialFeedState, [created(), delta(2, 'A'), delta(2, 'A')]);
    expect(state.stats.droppedRedundant).toBe(1);
    expect(state.stats.droppedLossy).toBe(0);
  });

  it('counts a duplicate of a buffered event as redundant', () => {
    const state = reduceAll(initialFeedState, [created(), delta(5, 'X'), delta(5, 'X')]);
    expect(state.stats.droppedRedundant).toBe(1);
    expect(state.stats.droppedLossy).toBe(0);
  });

  it('counts an unknown thread as lossy', () => {
    // The symptom. One of these means the feed is missing something.
    const state = feedReducer(initialFeedState, eventAction(delta(2, 'orphan')));
    expect(state.stats.droppedLossy).toBe(1);
    expect(state.stats.droppedRedundant).toBe(0);
  });

  it('keeps the two apart across a mixed stream', () => {
    // The whole point: from `dropped` alone these were indistinguishable.
    let state = reduceAll(initialFeedState, [created(), delta(2, 'A'), delta(2, 'A')]);
    state = feedReducer(state, eventAction({ ...delta(9, 'x'), threadId: 'other' }));

    expect(state.stats.droppedRedundant).toBe(1);
    expect(state.stats.droppedLossy).toBe(1);
    expect(totalDropped(state.stats)).toBe(2);
  });
});

describe('resync recovery (L1)', () => {
  const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
    id: T,
    prompt: 'where is my order?',
    agent: 'router',
    status: 'complete',
    createdAt: ts,
    lastSeq: 12,
    ...over,
  });

  it('keeps the whole transcript when the replay still has it', () => {
    // The bug this design replaced. Adopting the snapshot's `lastSeq` as a
    // watermark made every replayed event fail the already-applied gate, so a
    // thread whose entire history was sitting in the buffer rendered empty and
    // claimed its messages were unavailable.
    let state = feedReducer(initialFeedState, resyncAction([summary({ lastSeq: 4 })]));
    state = reduceAll(state, [
      created(T, 1),
      delta(2, 'Hel'),
      complete(3, 'Hello'),
      status(4, 'complete'),
    ]);

    expect(messageText(state)).toBe('Hello');
    expect(thread(state).historyTruncated).toBe(false);
    expect(thread(state).lastSeq).toBe(4);
    expect(state.stats.droppedRedundant).toBe(0);
  });

  it('rebuilds a thread the client never saw created', () => {
    const orphaned = feedReducer(initialFeedState, eventAction(delta(13, 'hi')));
    expect(orphaned.order).toEqual([]);
    expect(orphaned.stats.droppedLossy).toBe(1);

    const recovered = feedReducer(orphaned, resyncAction([summary()]));
    expect(recovered.order).toEqual([T]);
    expect(thread(recovered).prompt).toBe('where is my order?');
    // Assumed truncated until the replay proves otherwise.
    expect(thread(recovered).historyTruncated).toBe(true);
    expect(thread(recovered).awaitingResume).toBe(true);
  });

  it('accepts a replay that starts mid-thread, and marks it truncated', () => {
    let state = feedReducer(initialFeedState, resyncAction([summary({ lastSeq: 40 })]));
    // The buffer no longer holds this thread's first eighteen events.
    state = reduceAll(state, [delta(19, 'partial'), delta(20, ' text')]);

    expect(messageText(state)).toBe('partial text');
    expect(thread(state).historyTruncated).toBe(true);
    expect(thread(state).lastSeq).toBe(20);
  });

  it('leaves a thread with nothing to replay empty and marked unavailable', () => {
    // Its events rolled out entirely and it is finished, so none are coming.
    const state = feedReducer(initialFeedState, resyncAction([summary({ lastSeq: 12 })]));
    expect(thread(state).timeline).toEqual([]);
    expect(thread(state).historyTruncated).toBe(true);
  });

  it('does not claim truncation for a thread that produced nothing', () => {
    const state = feedReducer(initialFeedState, resyncAction([summary({ lastSeq: 0 })]));
    expect(thread(state).historyTruncated).toBe(false);
  });

  it('keeps what we already had when the replay continues contiguously', () => {
    let state = reduceAll(initialFeedState, [created(), delta(2, 'A')]);
    state = feedReducer(state, resyncAction([summary({ lastSeq: 3 })]));
    state = reduceAll(state, [delta(3, 'B')]);

    expect(messageText(state)).toBe('AB');
    expect(thread(state).historyTruncated).toBe(false);
    expect(thread(state).awaitingResume).toBe(false);
  });

  it('jumps a thread forward when the replay skips ahead of what we had', () => {
    let state = reduceAll(initialFeedState, [created(), delta(2, 'A')]);
    state = feedReducer(state, resyncAction([summary({ lastSeq: 40 })]));
    // A different message id: after a gap this is a new message, not more of m1.
    state = reduceAll(state, [delta(41, 'much later', 'm2')]);

    expect(thread(state).lastSeq).toBe(41);
    expect(thread(state).historyTruncated).toBe(true);
    // What we already had survives the jump.
    expect(messageText(state, 'm1')).toBe('A');
    expect(messageText(state, 'm2')).toBe('much later');
  });

  it('discards buffered events at or below the resumed point', () => {
    let state = reduceAll(initialFeedState, [created(), delta(6, 'held')]);
    expect(thread(state).buffered).toHaveLength(1);

    state = feedReducer(state, resyncAction([summary({ lastSeq: 40 })]));
    state = reduceAll(state, [delta(9, 'resumed')]);
    expect(thread(state).buffered).toHaveLength(0);
  });

  it('keeps local threads the snapshot does not mention', () => {
    const state = reduceAll(initialFeedState, [created('a'), created('b')]);
    const resynced = feedReducer(state, resyncAction([summary({ id: 'a', lastSeq: 3 })]));

    expect(resynced.order).toContain('b');
    expect(resynced.threads['b']).toBeDefined();
  });

  it('rebuilds the feed in creation order', () => {
    const state = feedReducer(
      initialFeedState,
      resyncAction([
        summary({ id: 'newer', createdAt: ts + 500 }),
        summary({ id: 'older', createdAt: ts }),
      ]),
    );
    expect(state.order).toEqual(['older', 'newer']);
  });

  it('counts the resync so recovery is observable', () => {
    const state = feedReducer(initialFeedState, resyncAction([summary()]));
    expect(state.stats.resyncs).toBe(1);
  });
});
