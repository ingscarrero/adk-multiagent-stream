/**
 * The two memory bounds: per subscriber, and per session.
 *
 * Both are about resources rather than output, so neither shows up in the
 * frame-level assertions in `stream.test.ts`. They are tested here against a
 * fake `Response` because the thing being asserted -- that Node's write queue
 * stopped growing -- is a property of the socket, and driving a real one into
 * sustained backpressure means writing megabytes and hoping the kernel buffer
 * behaves the same on every machine. The fake makes `writableLength` an input
 * instead of a race.
 *
 * What the fake gives up: it does not prove Express fires `close` on `end()`,
 * which is what releases the subscription. That is asserted in `stream.test.ts`
 * over a real socket.
 */

import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { memoryEventStream } from '@feed/providers';
import type { FeedEvent } from '@feed/protocol';
import { HubRegistry, SessionHub } from './sse.ts';

const OPTIONS = {
  heartbeatMs: 0,
  reconnectDelayMs: 1000,
  maxBufferedBytes: 500,
  idleTtlMs: 1000,
  sweepIntervalMs: 0,
};

const event = (seq: number): FeedEvent => ({
  type: 'message.delta',
  threadId: 'T',
  seq,
  ts: 1,
  messageId: 'm1',
  author: 'agent',
  delta: `chunk ${seq}`,
});

/**
 * A `Response` that reports whatever backlog the test wants.
 *
 * `draining` is the healthy consumer: everything written is consumed at once.
 * `stalled` never drains, so `writableLength` only grows -- which is exactly
 * the client this bound exists for.
 */
function fakeResponse(mode: 'draining' | 'stalled') {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    writableLength: 0,
    writeHead: () => res,
    flushHeaders: () => {},
    write(chunk: string) {
      if (res.writableEnded) return false;
      writes.push(chunk);
      if (mode === 'stalled') res.writableLength += Buffer.byteLength(chunk);
      return res.writableLength === 0;
    },
    end() {
      res.writableEnded = true;
    },
  };
  return { res: res as unknown as Response, writes, raw: res };
}

describe('L2 - a subscriber that stops draining is disconnected', () => {
  it('keeps a draining subscriber attached however much it is sent', async () => {
    const hub = new SessionHub('s', memoryEventStream({ retention: 500 }), OPTIONS);
    const { res, writes } = fakeResponse('draining');
    await hub.subscribe(res);

    for (let i = 1; i <= 200; i += 1) await hub.publish(event(i));

    expect(hub.subscriberCount).toBe(1);
    expect(hub.evictedSubscriberCount).toBe(0);
    // priming frame + 200 events
    expect(writes).toHaveLength(201);
  });

  it('disconnects a stalled subscriber once its queue passes the ceiling', async () => {
    const hub = new SessionHub('s', memoryEventStream({ retention: 500 }), OPTIONS);
    const { res, raw } = fakeResponse('stalled');
    await hub.subscribe(res);

    for (let i = 1; i <= 200; i += 1) await hub.publish(event(i));

    expect(hub.subscriberCount).toBe(0);
    expect(hub.evictedSubscriberCount).toBe(1);
    expect(raw.writableEnded).toBe(true);
    // The bound is the point: the queue stops near the ceiling instead of
    // growing for all 200 events.
    expect(raw.writableLength).toBeLessThan(OPTIONS.maxBufferedBytes * 2);
  });

  it('does not write to a subscriber after ending it', async () => {
    const hub = new SessionHub('s', memoryEventStream({ retention: 500 }), OPTIONS);
    const { res, raw } = fakeResponse('stalled');
    await hub.subscribe(res);

    for (let i = 1; i <= 50; i += 1) await hub.publish(event(i));
    const afterEviction = raw.writableLength;
    for (let i = 51; i <= 100; i += 1) await hub.publish(event(i));

    // Writing to an ended response throws ERR_STREAM_WRITE_AFTER_END on a real
    // socket, so the guard has to hold for every later event, not just the one
    // that triggered eviction.
    expect(raw.writableLength).toBe(afterEviction);
  });

  it('evicting one subscriber leaves the others streaming', async () => {
    const hub = new SessionHub('s', memoryEventStream({ retention: 500 }), OPTIONS);
    const healthy = fakeResponse('draining');
    const stalled = fakeResponse('stalled');
    await hub.subscribe(healthy.res);
    await hub.subscribe(stalled.res);

    for (let i = 1; i <= 200; i += 1) await hub.publish(event(i));

    expect(hub.subscriberCount).toBe(1);
    expect(stalled.raw.writableEnded).toBe(true);
    expect(healthy.raw.writableEnded).toBe(false);
    expect(healthy.writes).toHaveLength(201);
  });
});

describe('L3 - idle sessions are swept, log included', () => {
  const idleRegistry = (stream = memoryEventStream({ retention: 500 })) => ({
    stream,
    registry: new HubRegistry(stream, { ...OPTIONS, idleTtlMs: 0 }),
  });

  it('sweeps a hub with no subscribers', async () => {
    const { registry } = idleRegistry();
    await registry.get('a').publish(event(1));
    expect(registry.size).toBe(1);

    expect(await registry.sweepIdle()).toBe(1);
    expect(registry.size).toBe(0);
  });

  it('drops the session log too, not just the hub', async () => {
    const { stream, registry } = idleRegistry();
    await registry.get('a').publish(event(1));
    await registry.get('a').publish(event(2));

    await registry.sweepIdle();

    // The hub is the small half; the retained events are the large one. A sweep
    // that frees only the hub leaves the memory it was supposed to reclaim.
    const sub = await stream.open('a', null, () => {});
    expect(sub.replay).toEqual([]);
    await sub.close();
  });

  it('never sweeps a hub that still has a subscriber', async () => {
    const registry = new HubRegistry(memoryEventStream({ retention: 500 }), {
      ...OPTIONS,
      idleTtlMs: 0,
    });
    const hub = registry.get('a');
    const { res } = fakeResponse('draining');
    await hub.subscribe(res);

    expect(await registry.sweepIdle()).toBe(0);
    expect(registry.size).toBe(1);
  });

  it('publishing counts as activity, so an unwatched run is not thrown away', async () => {
    const stream = memoryEventStream({ retention: 500 });
    // A TTL longer than the test: the hub is only spared if `publish` bumped
    // the clock, which is the case of a client that closed the tab mid-run.
    const registry = new HubRegistry(stream, { ...OPTIONS, idleTtlMs: 60_000 });
    await registry.get('a').publish(event(1));

    expect(await registry.sweepIdle()).toBe(0);
    expect(registry.size).toBe(1);
  });

  it('a session id that comes back after a sweep starts clean', async () => {
    const { registry } = idleRegistry();
    await registry.get('a').publish(event(1));
    await registry.sweepIdle();

    const entry = await registry.get('a').publish(event(1));
    // Offsets restart at 1. If they carried on from before, `oldestOffset`
    // would sit above a fresh client's position and every connect would resync.
    expect(entry.offset).toBe(1);
  });

  it('sweeps only what is stale, leaving live sessions alone', async () => {
    const stream = memoryEventStream({ retention: 500 });
    const registry = new HubRegistry(stream, { ...OPTIONS, idleTtlMs: 0 });
    await registry.get('stale').publish(event(1));
    const watched = registry.get('watched');
    await watched.subscribe(fakeResponse('draining').res);

    expect(await registry.sweepIdle()).toBe(1);
    expect(registry.size).toBe(1);

    const kept = await stream.open('watched', null, () => {});
    expect(kept.replay).toEqual([]);
    await kept.close();
    expect(registry.get('watched')).toBe(watched);
  });

  it('closeAll stops the sweeper so the process can exit', () => {
    const registry = new HubRegistry(memoryEventStream({ retention: 10 }), {
      ...OPTIONS,
      sweepIntervalMs: 10,
    });
    registry.closeAll();
    // No assertion beyond not hanging: an un-cleared interval keeps the event
    // loop alive and turns a passing suite into one that never exits.
    expect(registry.size).toBe(0);
  });
});
