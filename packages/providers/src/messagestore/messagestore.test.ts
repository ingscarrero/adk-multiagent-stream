/**
 * The contract every MessageStore adapter must satisfy.
 *
 * Written against the port so a Postgres adapter runs the identical suite. The
 * cases that matter are the ones recovery depends on: deltas are never stored,
 * appends are idempotent by seq, transcripts come back in seq order, and a
 * thread with nothing stored is distinguishable from one that stored nothing.
 */
import { describe, expect, it } from 'vitest';
import type { FeedEvent } from '@feed/protocol';
import { memoryMessageStore } from './memory.ts';
import type { MessageStore } from './port.ts';

const created = (seq = 1): FeedEvent => ({
  type: 'thread.created',
  threadId: 'T',
  seq,
  ts: seq,
  prompt: 'where is my order?',
  agent: 'router',
});

const complete = (seq: number, text: string): FeedEvent => ({
  type: 'message.complete',
  threadId: 'T',
  seq,
  ts: seq,
  messageId: 'm1',
  author: 'order_agent',
  text,
});

const delta = (seq: number): FeedEvent => ({
  type: 'message.delta',
  threadId: 'T',
  seq,
  ts: seq,
  messageId: 'm1',
  author: 'order_agent',
  delta: 'chunk ',
});

function storeContract(name: string, make: () => MessageStore) {
  describe(`MessageStore contract: ${name}`, () => {
    it('keeps settled events in seq order', async () => {
      const store = make();
      await store.append('T', created(1));
      await store.append('T', complete(3, 'done'));
      const status: FeedEvent = {
        type: 'thread.status',
        threadId: 'T',
        seq: 2,
        ts: 2,
        status: 'running',
      };
      await store.append('T', status);

      expect((await store.transcript('T')).map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it('never stores a delta', async () => {
      // The economy of the whole design: ~5 writes per turn instead of 23.
      const store = make();
      await store.append('T', created(1));
      for (let seq = 2; seq <= 20; seq += 1) await store.append('T', delta(seq));
      await store.append('T', complete(21, 'the whole answer'));

      const transcript = await store.transcript('T');
      expect(transcript.map((e) => e.type)).toEqual(['thread.created', 'message.complete']);
    });

    it('repairs order and overwrites duplicates once appends leave the monotonic path', async () => {
      // The fast path is append-only for a monotonic seq; this is everything
      // else. Gaps filled late land in place, and a re-sent seq replaces the
      // earlier copy rather than sitting beside it.
      const store = make();
      await store.append('T', created(1));
      await store.append('T', complete(3, 'third'));
      await store.append('T', complete(5, 'fifth'));
      await store.append('T', complete(2, 'second'));
      await store.append('T', complete(4, 'fourth'));
      await store.append('T', complete(3, 'third, again'));
      await store.append('T', complete(6, 'sixth'));

      const transcript = await store.transcript('T');
      expect(transcript.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(transcript[2]).toMatchObject({ seq: 3, text: 'third, again' });
    });

    it('is idempotent by seq, so a replay does not double the transcript', async () => {
      const store = make();
      await store.append('T', created(1));
      await store.append('T', complete(2, 'done'));
      await store.append('T', created(1));
      await store.append('T', complete(2, 'done'));

      expect(await store.transcript('T')).toHaveLength(2);
    });

    it('keeps threads apart', async () => {
      const store = make();
      await store.append('A', { ...created(1), threadId: 'A' });
      await store.append('B', { ...created(1), threadId: 'B' });

      expect(await store.transcript('A')).toHaveLength(1);
      expect((await store.transcript('A'))[0]?.threadId).toBe('A');
    });

    it('returns an empty transcript for an unknown thread', async () => {
      expect(await make().transcript('never-existed')).toEqual([]);
    });

    it('omits unknown threads from a bulk read rather than returning them empty', async () => {
      // A caller needs to tell "nothing stored for this thread" from "this
      // thread stored nothing", because only the first means look elsewhere.
      const store = make();
      await store.append('A', { ...created(1), threadId: 'A' });

      const many = await store.transcripts(['A', 'ghost']);
      expect([...many.keys()]).toEqual(['A']);
    });

    it('reads many threads in one call', async () => {
      const store = make();
      for (const id of ['A', 'B', 'C']) await store.append(id, { ...created(1), threadId: id });

      const many = await store.transcripts(['A', 'B', 'C']);
      expect(many.size).toBe(3);
      expect(many.get('B')?.[0]?.threadId).toBe('B');
    });

    it('does not retain -- a transcript outlives the session that produced it', async () => {
      // Deliberately no drop(sessionId). The event stream has one because its
      // window is scratch space; this is the thing that is supposed to survive.
      const store = make();
      await store.append('T', created(1));
      for (let seq = 2; seq <= 2000; seq += 2) await store.append('T', complete(seq, `#${seq}`));

      expect((await store.transcript('T')).length).toBeGreaterThan(500);
    });
  });
}

storeContract('memory', () => memoryMessageStore());
