/**
 * The contract every EventStream adapter must satisfy.
 *
 * Written against the port so a Redis adapter runs the identical suite. The
 * cases that matter are the ones the SSE hub depends on: offsets are dense and
 * start at 1, retention is observable through `oldestOffset`, and nothing is
 * lost or duplicated across the open/flush boundary.
 */
import { describe, expect, it } from 'vitest';
import type { FeedEvent } from '@feed/protocol';
import { memoryEventStream } from './memory.ts';
import type { EventStream, StreamEntry } from './port.ts';

const event = (seq: number): FeedEvent => ({
  type: 'message.delta',
  threadId: 'T',
  seq,
  ts: 1,
  messageId: 'm1',
  author: 'a',
  delta: `#${seq}`,
});

function streamContract(name: string, make: (retention: number) => EventStream) {
  describe(`EventStream contract: ${name}`, () => {
    it('assigns dense offsets starting at 1', async () => {
      const stream = make(100);
      const offsets = [];
      for (let i = 1; i <= 3; i += 1) offsets.push((await stream.append('s', event(i))).offset);
      expect(offsets).toEqual([1, 2, 3]);
    });

    it('keeps sessions independent', async () => {
      const stream = make(100);
      await stream.append('a', event(1));
      const b = await stream.append('b', event(1));
      // Offsets are per session, so b starts its own count.
      expect(b.offset).toBe(1);
    });

    it('replays everything when the subscriber has no resume point', async () => {
      const stream = make(100);
      for (let i = 1; i <= 3; i += 1) await stream.append('s', event(i));

      const sub = await stream.open('s', null, () => {});
      expect(sub.replay.map((e) => e.offset)).toEqual([1, 2, 3]);
      expect(sub.oldestOffset).toBe(1);
      await sub.close();
    });

    it('replays only what comes after a resume point', async () => {
      const stream = make(100);
      for (let i = 1; i <= 4; i += 1) await stream.append('s', event(i));

      const sub = await stream.open('s', 2, () => {});
      expect(sub.replay.map((e) => e.offset)).toEqual([3, 4]);
      await sub.close();
    });

    it('reports the oldest retained offset once retention has bitten', async () => {
      // This is what overrun detection reads: a resume point below it means a
      // prefix is gone and the subscriber must resync.
      const stream = make(3);
      for (let i = 1; i <= 5; i += 1) await stream.append('s', event(i));

      const sub = await stream.open('s', null, () => {});
      expect(sub.oldestOffset).toBe(3);
      expect(sub.replay.map((e) => e.offset)).toEqual([3, 4, 5]);
      await sub.close();
    });

    it('delivers live entries after flush', async () => {
      const stream = make(100);
      const seen: StreamEntry[] = [];
      const sub = await stream.open('s', null, (e) => seen.push(e));
      sub.flush();

      await stream.append('s', event(1));
      expect(seen.map((e) => e.offset)).toEqual([1]);
      await sub.close();
    });

    it('loses nothing appended between open and flush', async () => {
      // The race the open/flush shape exists to prevent: replay and subscribe
      // as two separate calls would drop this entry.
      const stream = make(100);
      await stream.append('s', event(1));

      const seen: StreamEntry[] = [];
      const sub = await stream.open('s', null, (e) => seen.push(e));
      await stream.append('s', event(2)); // arrives while the caller writes replay
      sub.flush();

      expect(sub.replay.map((e) => e.offset)).toEqual([1]);
      expect(seen.map((e) => e.offset)).toEqual([2]);
      await sub.close();
    });

    it('does not deliver an entry twice when it is already in the replay', async () => {
      const stream = make(100);
      const seen: StreamEntry[] = [];
      const sub = await stream.open('s', null, (e) => seen.push(e));
      await stream.append('s', event(1));
      // The entry landed after open, so it is live rather than replayed.
      sub.flush();
      expect(sub.replay).toEqual([]);
      expect(seen.map((e) => e.offset)).toEqual([1]);
      await sub.close();
    });

    it('stops delivering after close', async () => {
      const stream = make(100);
      const seen: StreamEntry[] = [];
      const sub = await stream.open('s', null, (e) => seen.push(e));
      sub.flush();
      await sub.close();

      await stream.append('s', event(1));
      expect(seen).toEqual([]);
    });

    it('serves several subscribers of one session', async () => {
      // In-process this is a loop; across instances it is pub/sub. Either way
      // every live subscriber gets every entry.
      const stream = make(100);
      const a: number[] = [];
      const b: number[] = [];
      const subA = await stream.open('s', null, (e) => a.push(e.offset));
      const subB = await stream.open('s', null, (e) => b.push(e.offset));
      subA.flush();
      subB.flush();

      await stream.append('s', event(1));
      expect(a).toEqual([1]);
      expect(b).toEqual([1]);
      await subA.close();
      await subB.close();
    });

    it('buffers with no subscribers, so a run that starts before anyone connects is not lost', async () => {
      const stream = make(100);
      await stream.append('s', event(1));
      const sub = await stream.open('s', null, () => {});
      expect(sub.replay).toHaveLength(1);
      await sub.close();
    });
  });
}

streamContract('memory', (retention) => memoryEventStream({ retention }));
