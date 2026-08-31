/**
 * Integration tests over real HTTP with a real SSE connection.
 *
 * These are the tests that would have caught every ordering bug this repo is
 * about. They boot the actual Express app on an ephemeral port, open a real
 * `EventSource`-shaped connection with `fetch`, and assert on the bytes.
 *
 * Nothing is mocked except the model, which is the scripted one — so the ADK
 * runner, the translator, the sequencing, and the SSE framing are all live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { feedEventSchema, threadsSnapshotSchema, type FeedEvent } from '@feed/protocol';
import { createApp, type FeedApp } from './app.ts';
import { loadConfig } from './config.ts';

let feed: FeedApp;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  feed = createApp({
    config: {
      ...loadConfig({ MODEL_MODE: 'scripted' }),
      heartbeatMs: 0,
    },
    // Zero chunk delay: these tests assert on order and content, never timing.
    runnerOptions: { chunkDelayMs: 0 },
  });
  server = await new Promise<Server>((resolve) => {
    const s = feed.app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await feed.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Parses an SSE byte stream into feed events, stopping when `done` says so. */
async function readStream(
  url: string,
  done: (events: FeedEvent[]) => boolean,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ events: FeedEvent[]; ids: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  options.signal?.addEventListener('abort', () => controller.abort());

  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const events: FeedEvent[] = [];
  const ids: string[] = [];
  let buffer = '';

  try {
    while (!done(events)) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const idLine = frame.split('\n').find((line) => line.startsWith('id: '));
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue; // heartbeat or resync notice

        if (idLine) ids.push(idLine.slice(4));
        events.push(feedEventSchema.parse(JSON.parse(dataLine.slice(6))));
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  return { events, ids };
}

async function startThread(sessionId: string, prompt: string, agent = 'router') {
  const response = await fetch(`${baseUrl}/api/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
    body: JSON.stringify({ prompt, agent }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as { threadId: string };
}

const terminal = (events: FeedEvent[], threadId: string) =>
  events.some(
    (e) =>
      e.threadId === threadId &&
      e.type === 'thread.status' &&
      ['complete', 'error', 'cancelled'].includes(e.status),
  );

describe('single thread', () => {
  it('streams a thread from creation to completion in seq order', async () => {
    const sessionId = 's-single';
    const { threadId } = await startThread(sessionId, 'where is my order?');

    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => terminal(all, threadId),
    );

    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...Array(seqs.length).keys()].map((i) => i + 1));

    expect(events[0]).toMatchObject({ type: 'thread.created', seq: 1, prompt: 'where is my order?' });
    expect(events.at(-1)).toMatchObject({ type: 'thread.status', status: 'complete' });
  });

  it('reconstructs the final message exactly from its deltas', async () => {
    // The client's accumulate-then-replace strategy is only safe if this holds.
    const sessionId = 's-deltas';
    const { threadId } = await startThread(sessionId, 'what is your return policy?');
    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => terminal(all, threadId),
    );

    const completes = events.filter((e) => e.type === 'message.complete');
    expect(completes.length).toBeGreaterThan(0);

    for (const complete of completes) {
      const rebuilt = events
        .flatMap((e) =>
          e.type === 'message.delta' && e.messageId === complete.messageId ? [e.delta] : [],
        )
        .join('');
      expect(rebuilt).toBe(complete.text);
    }
  });

  it('reports tool calls and results in matched pairs', async () => {
    const sessionId = 's-tools';
    const { threadId } = await startThread(sessionId, 'where is my order, can you track shipping?');
    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => terminal(all, threadId),
    );

    const calls = events.filter((e) => e.type === 'tool.call');
    const results = events.filter((e) => e.type === 'tool.result');

    expect(calls.map((c) => c.name)).toEqual([
      'transfer_to_agent',
      'lookupOrder',
      'checkShippingStatus',
    ]);
    // Every call is answered, and every result is preceded by its call.
    for (const call of calls) {
      const result = results.find((r) => r.callId === call.callId);
      expect(result, `no result for ${call.name}`).toBeDefined();
      expect(result!.seq).toBeGreaterThan(call.seq);
    }
  });

  it('never leaves a thread in a non-terminal status', async () => {
    const sessionId = 's-terminal';
    const { threadId } = await startThread(sessionId, 'please fail');
    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => terminal(all, threadId),
    );

    expect(events.at(-1)).toMatchObject({ type: 'thread.status', status: 'error' });
    expect(events.some((e) => e.type === 'thread.error')).toBe(true);
  });
});

describe('concurrent threads', () => {
  it('multiplexes three threads on one connection, each with its own seq', async () => {
    const sessionId = 's-concurrent';
    const started = await Promise.all([
      startThread(sessionId, 'where is my order, can you track shipping?'),
      startThread(sessionId, 'what is your warranty coverage?'),
      startThread(sessionId, 'how should we position the product?', 'research'),
    ]);
    const ids = started.map((s) => s.threadId);

    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => ids.every((id) => terminal(all, id)),
      { timeoutMs: 20_000 },
    );

    for (const id of ids) {
      const forThread = events.filter((e) => e.threadId === id);
      // Per-thread sequences are independent and gapless.
      expect(forThread.map((e) => e.seq)).toEqual(
        [...Array(forThread.length).keys()].map((i) => i + 1),
      );
      expect(forThread[0]?.type).toBe('thread.created');
    }
  });

  it('interleaves threads on the wire rather than serialising them', async () => {
    // If this fails, the threads are running one after another and the whole
    // concurrency story is theatre.
    const sessionId = 's-interleave';
    const started = await Promise.all([
      startThread(sessionId, 'where is my order, can you track shipping?'),
      startThread(sessionId, 'what is your warranty coverage?'),
    ]);
    const ids = started.map((s) => s.threadId);

    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => ids.every((id) => terminal(all, id)),
      { timeoutMs: 20_000 },
    );

    const order = events.map((e) => e.threadId);
    const switches = order.filter((id, i) => i > 0 && id !== order[i - 1]).length;
    expect(switches).toBeGreaterThan(1);
  });

  it('keeps each parallel sub-agent in its own message', async () => {
    const sessionId = 's-parallel';
    const { threadId } = await startThread(sessionId, 'how should we position?', 'research');
    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => terminal(all, threadId),
      { timeoutMs: 20_000 },
    );

    const byAuthor = new Map<string, Set<string>>();
    for (const event of events) {
      if (event.type !== 'message.delta' && event.type !== 'message.complete') continue;
      const ids = byAuthor.get(event.author) ?? new Set();
      ids.add(event.messageId);
      byAuthor.set(event.author, ids);
    }

    expect([...byAuthor.keys()].sort()).toEqual(['docs_researcher', 'market_researcher', 'synthesizer']);
    // No messageId is shared between two authors.
    const all = [...byAuthor.values()].flatMap((set) => [...set]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('reconnect', () => {
  it('replays missed events from Last-Event-ID without duplicating them', async () => {
    const sessionId = 's-reconnect';
    const { threadId } = await startThread(sessionId, 'what is your return policy?');

    // First connection: read a few events, then drop it.
    const first = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => all.length >= 3,
    );
    const lastId = first.ids.at(-1)!;

    const second = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}&lastEventId=${lastId}`,
      (all) => terminal(all, threadId),
    );

    // No overlap, no gap: the two halves concatenate into one gapless sequence.
    const combined = [...first.events, ...second.events].filter((e) => e.threadId === threadId);
    expect(combined.map((e) => e.seq)).toEqual(
      [...Array(combined.length).keys()].map((i) => i + 1),
    );
  });

  it('replays the whole buffer to a client that connects after the thread started', async () => {
    const sessionId = 's-late';
    const { threadId } = await startThread(sessionId, 'what is your return policy?');
    await feed.threads.drain(); // let the run finish with nobody listening

    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=${sessionId}`,
      (all) => terminal(all, threadId),
    );

    expect(events[0]).toMatchObject({ type: 'thread.created', seq: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'thread.status', status: 'complete' });
  });

  it('isolates sessions from each other', async () => {
    await startThread('s-alice', 'what is your return policy?');
    const bob = await startThread('s-bob', 'what is your warranty coverage?');

    const { events } = await readStream(
      `${baseUrl}/api/stream?sessionId=s-bob`,
      (all) => terminal(all, bob.threadId),
    );
    expect(events.every((e) => e.threadId === bob.threadId)).toBe(true);
  });
});

describe('cancellation', () => {
  it('ends a running thread in cancelled and closes its open message', async () => {
    // A separate app with a slow model, so the cancel lands mid-stream rather
    // than after the run has already finished.
    const slow = createApp({
      config: { ...loadConfig({ MODEL_MODE: 'scripted' }), heartbeatMs: 0 },
      runnerOptions: { chunkDelayMs: 40 },
    });
    const slowServer = await new Promise<Server>((resolve) => {
      const s = slow.app.listen(0, () => resolve(s));
    });
    const port = (slowServer.address() as { port: number }).port;
    const slowUrl = `http://127.0.0.1:${port}`;

    try {
      const created = await fetch(`${slowUrl}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-cancel' },
        body: JSON.stringify({ prompt: 'what is your return policy?' }),
      });
      const { threadId } = (await created.json()) as { threadId: string };

      await new Promise((resolve) => setTimeout(resolve, 150));
      const cancelled = await fetch(`${slowUrl}/api/threads/${threadId}/cancel`, { method: 'POST' });
      expect(cancelled.status).toBe(202);

      await slow.threads.drain();

      const { events } = await readStream(
        `${slowUrl}/api/stream?sessionId=s-cancel`,
        (all) => terminal(all, threadId),
      );

      expect(events.at(-1)).toMatchObject({ type: 'thread.status', status: 'cancelled' });
      // Any message left mid-stream is closed out, so no caret is left blinking.
      const lastMessage = events.findLast(
        (e) => e.type === 'message.delta' || e.type === 'message.complete',
      );
      if (lastMessage) expect(lastMessage.type).toBe('message.complete');
    } finally {
      await slow.close();
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  });

  it('404s an unknown thread and 409s a finished one', async () => {
    const { threadId } = await startThread('s-cancel-2', 'hello');
    await feed.threads.drain();

    expect((await fetch(`${baseUrl}/api/threads/nope/cancel`, { method: 'POST' })).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/api/threads/${threadId}/cancel`, { method: 'POST' })).status,
    ).toBe(409);
  });
});

describe('replay-buffer overrun (L1)', () => {
  /**
   * The path that went unnoticed for so long: nothing exercised an overrun,
   * because the default 500-event buffer is never reached in normal use. These
   * force it with a deliberately tiny buffer.
   */
  async function tinyBufferApp(retention: number) {
    const base = loadConfig({ MODEL_MODE: 'scripted' });
    const app = createApp({
      config: {
        ...base,
        heartbeatMs: 0,
        // Retention belongs to the event stream provider now, so a tiny buffer
        // is configured there rather than on the server config.
        providers: { ...base.providers, eventRetention: retention },
      },
      runnerOptions: { chunkDelayMs: 0 },
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    return {
      app,
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        await app.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /**
   * Reads raw SSE bytes until `needle` appears or the stream goes quiet.
   * The priming frame and the resync notice arrive as separate chunks, so a
   * single `read()` is not enough to decide either way.
   */
  async function readRawUntil(url: string, needle: string, timeoutMs = 1500): Promise<string> {
    // Bounded by time, not by a chunk count. How many TCP chunks a set of
    // frames arrives in is environment-dependent -- locally these writes land
    // in several, on CI they coalesce -- so counting reads meant the negative
    // cases blocked forever on an idle stream and timed out the test.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text = '';
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes(needle)) break;
      }
      await reader.cancel().catch(() => {});
    } catch {
      // Aborting on the deadline is how the negative cases finish.
    } finally {
      clearTimeout(timer);
    }
    return text;
  }

  it('emits a resync frame when the requested offset has rolled out', async () => {
    const tiny = await tinyBufferApp(3);
    try {
      const created = await fetch(`${tiny.url}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-overrun' },
        body: JSON.stringify({ prompt: 'what is your warranty coverage?' }),
      });
      expect(created.status).toBe(202);
      await tiny.app.threads.drain();

      // Ask to resume from offset 1, which a 3-event buffer has long discarded.
      const text = await readRawUntil(
        `${tiny.url}/api/stream?sessionId=s-overrun&lastEventId=1`,
        'event: resync',
      );

      expect(text).toContain('event: resync');
      // The notice names the oldest offset still held, which is what the client
      // cannot bridge on its own.
      expect(text).toMatch(/event: resync\ndata: \{"from":\d+\}/);
    } finally {
      await tiny.close();
    }
  });

  it('emits resync to a FRESH client when the session start has rolled out', async () => {
    // Regression. The first version of this fix only checked the resuming
    // branch, so a page reload -- which sends no `lastEventId` at all -- got a
    // mid-stream prefix with no notice, dropped every event for a thread it
    // had never seen created, and rendered an empty feed. The client has no
    // wrong offset to detect here; it simply starts in the middle.
    const tiny = await tinyBufferApp(4);
    try {
      await fetch(`${tiny.url}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-fresh' },
        body: JSON.stringify({ prompt: 'Where is my order, can you track shipping?' }),
      });
      await tiny.app.threads.drain();

      // No lastEventId, exactly as a reloaded page connects.
      const text = await readRawUntil(
        `${tiny.url}/api/stream?sessionId=s-fresh`,
        'event: resync',
      );
      expect(text).toContain('event: resync');
    } finally {
      await tiny.close();
    }
  });

  it('does not emit resync to a fresh client when the whole session still fits', async () => {
    const tiny = await tinyBufferApp(500);
    try {
      await fetch(`${tiny.url}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-whole' },
        body: JSON.stringify({ prompt: 'what is your warranty coverage?' }),
      });
      await tiny.app.threads.drain();

      const text = await readRawUntil(
        `${tiny.url}/api/stream?sessionId=s-whole`,
        'event: resync',
      );
      expect(text).not.toContain('event: resync');
      // And the thread's opening event is still there to be replayed.
      expect(text).toContain('"type":"thread.created"');
    } finally {
      await tiny.close();
    }
  });

  it('stops asking once the client resumes from the offset the notice named', async () => {
    // The other half of the loop fix. `from` must be a resume point that
    // actually satisfies the overrun test, or a client that obeys the notice is
    // told to resync again immediately and never keeps a stream open.
    const tiny = await tinyBufferApp(4);
    try {
      await fetch(`${tiny.url}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-loop' },
        body: JSON.stringify({ prompt: 'what is your warranty coverage?' }),
      });
      await tiny.app.threads.drain();

      const first = await readRawUntil(`${tiny.url}/api/stream?sessionId=s-loop`, 'event: resync');
      const from = Number(/"from":(\d+)/.exec(first)?.[1]);
      expect(from).toBeGreaterThan(1);

      // Exactly what the client does next: resume from `from - 1`.
      const second = await readRawUntil(
        `${tiny.url}/api/stream?sessionId=s-loop&lastEventId=${from - 1}`,
        'event: resync',
      );
      expect(second).not.toContain('event: resync');
      // And it still gets the full replay the notice promised.
      expect(second).toContain(`id: ${from}`);
    } finally {
      await tiny.close();
    }
  });

  it('does not emit resync when the buffer still covers the resume point', async () => {
    const tiny = await tinyBufferApp(500);
    try {
      await fetch(`${tiny.url}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-covered' },
        body: JSON.stringify({ prompt: 'what is your warranty coverage?' }),
      });
      await tiny.app.threads.drain();

      const text = await readRawUntil(
        `${tiny.url}/api/stream?sessionId=s-covered&lastEventId=1`,
        'event: resync',
      );
      expect(text).not.toContain('event: resync');
    } finally {
      await tiny.close();
    }
  });

  it('serves a snapshot that carries each thread\'s lastSeq', async () => {
    // `lastSeq` is what lets a recovering client resume contiguously; without
    // it the next live event looks like a gap that can never close.
    const tiny = await tinyBufferApp(3);
    try {
      const created = await fetch(`${tiny.url}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-snap' },
        body: JSON.stringify({ prompt: 'what is your warranty coverage?' }),
      });
      const { threadId } = (await created.json()) as { threadId: string };
      await tiny.app.threads.drain();

      const snapshot = await fetch(`${tiny.url}/api/threads?sessionId=s-snap`);
      const body = threadsSnapshotSchema.parse(await snapshot.json());

      expect(body.threads).toHaveLength(1);
      expect(body.threads[0]).toMatchObject({
        id: threadId,
        prompt: 'what is your warranty coverage?',
        agent: 'router',
        status: 'complete',
      });
      // The thread ran to completion, so its sequence is well past 1.
      expect(body.threads[0]!.lastSeq).toBeGreaterThan(1);
    } finally {
      await tiny.close();
    }
  });

  it('scopes the snapshot to one session', async () => {
    const tiny = await tinyBufferApp(50);
    try {
      for (const sessionId of ['s-a', 's-b']) {
        await fetch(`${tiny.url}/api/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
          body: JSON.stringify({ prompt: 'what is your warranty coverage?' }),
        });
      }
      await tiny.app.threads.drain();

      const snapshot = await fetch(`${tiny.url}/api/threads?sessionId=s-a`);
      const body = threadsSnapshotSchema.parse(await snapshot.json());
      expect(body.threads).toHaveLength(1);
    } finally {
      await tiny.close();
    }
  });

  it('rejects a snapshot request with no sessionId', async () => {
    const response = await fetch(`${baseUrl}/api/threads`);
    expect(response.status).toBe(400);
  });
});

describe('SSE framing', () => {
  it('writes a body byte immediately, so intermediaries flush the headers', async () => {
    // Regression: with only `flushHeaders()`, a dev proxy or load balancer
    // holds its own response headers until the first body chunk. On an idle
    // feed that could be a heartbeat 15s later, and the browser's EventSource
    // sits in CONNECTING without ever firing `onopen`.
    const response = await fetch(`${baseUrl}/api/stream?sessionId=s-prime`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const first = await response.body!.getReader().read();
    const text = new TextDecoder().decode(first.value);

    // The retry directive sets the browser's reconnect backoff, and the comment
    // is the byte that forces the flush.
    expect(text).toContain('retry: ');
    expect(text).toContain(': connected');

    await response.body!.cancel().catch(() => {});
  });
});

describe('validation', () => {
  it('rejects a request with no sessionId', async () => {
    const response = await fetch(`${baseUrl}/api/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects an empty prompt and an unknown agent', async () => {
    const post = (body: unknown) =>
      fetch(`${baseUrl}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 's-v' },
        body: JSON.stringify(body),
      });

    expect((await post({ prompt: '' })).status).toBe(400);
    expect((await post({ prompt: 'hi', agent: 'nope' })).status).toBe(400);
  });

  it('reports health with the active model mode', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(await response.json()).toMatchObject({ status: 'ok', modelMode: 'scripted' });
  });
});
