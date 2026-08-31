/**
 * The multiplexed SSE hub.
 *
 * One HTTP connection per browser session carries the events of *every* thread
 * in that session. See docs/STREAMING-CONTRACT.md for why this shape was chosen
 * over one connection per thread.
 *
 * ## Two counters, deliberately
 *
 * - **`seq`** (on the event, assigned by `ThreadRunner`) is *per thread* and
 *   expresses ordering semantics: what happened in what order within a thread.
 * - **`offset`** (the SSE `id:` field, assigned here) is *per session* and
 *   exists purely for transport resume: it is what a reconnecting browser sends
 *   back in `Last-Event-ID`.
 *
 * Conflating the two is the classic bug. A single global counter cannot express
 * per-thread ordering once threads interleave, and a per-thread counter cannot
 * drive `Last-Event-ID` on a shared connection.
 */

import type { Response } from 'express';
import { SSE_EVENT_NAME, SSE_RESYNC_EVENT_NAME, type FeedEvent } from '@feed/protocol';

interface BufferedEvent {
  offset: number;
  event: FeedEvent;
}

export interface SessionHubOptions {
  heartbeatMs: number;
  replayBufferSize: number;
  /** Reconnect backoff advertised to the browser via the SSE `retry:` field. */
  reconnectDelayMs: number;
}

/** Everything belonging to one browser session's feed. */
export class SessionHub {
  private readonly subscribers = new Set<Response>();
  private readonly buffer: BufferedEvent[] = [];
  private nextOffset = 1;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    readonly sessionId: string,
    private readonly options: SessionHubOptions,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** The highest offset published so far. */
  get latestOffset(): number {
    return this.nextOffset - 1;
  }

  /**
   * Publishes an event to every live subscriber and to the replay buffer.
   *
   * Buffering happens even with zero subscribers: a thread started before the
   * stream is open (or while the browser is reconnecting) must not lose events.
   */
  publish(event: FeedEvent): void {
    const buffered: BufferedEvent = { offset: this.nextOffset++, event };

    this.buffer.push(buffered);
    if (this.buffer.length > this.options.replayBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.options.replayBufferSize);
    }

    const frame = formatFrame(buffered);
    for (const subscriber of this.subscribers) {
      subscriber.write(frame);
    }
  }

  /**
   * Attaches a response as an SSE subscriber.
   *
   * @param lastEventId The client's `Last-Event-ID`, if it is reconnecting.
   * @returns A detach function; call it on connection close.
   */
  subscribe(res: Response, lastEventId?: string): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer proxied responses by default, which turns a
      // token stream into one big delivery at the end.
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately so the browser fires `onopen` without waiting
    // for the first event.
    res.flushHeaders?.();

    // Then write an actual byte, immediately.
    //
    // `flushHeaders` only flushes *this* response. Any intermediary — a dev
    // proxy, nginx, a load balancer — has its own outbound response, and Node
    // does not put those headers on the wire until something writes a body
    // chunk. On an idle feed the first chunk could be a heartbeat 15 seconds
    // later, during which the browser's EventSource sits in CONNECTING and
    // never fires `onopen`. A comment frame costs nothing and makes the
    // handshake complete through every hop.
    //
    // `retry:` sets the browser's reconnect backoff at the same time, which is
    // otherwise a browser-specific default we have no control over.
    // One write, so the priming frame cannot be split across chunks.
    res.write(`retry: ${this.options.reconnectDelayMs}\n: connected\n\n`);

    this.replayTo(res, lastEventId);
    this.subscribers.add(res);
    this.ensureHeartbeat();

    return () => {
      this.subscribers.delete(res);
      if (this.subscribers.size === 0) this.stopHeartbeat();
    };
  }

  /**
   * Replays everything the client missed.
   *
   * If the requested offset has already fallen out of the bounded buffer we
   * replay what remains and emit a `resync` frame first, so the client knows
   * its resume point was unreachable and can rebuild from `GET /api/threads`
   * rather than silently rendering a feed with a hole in it.
   */
  private replayTo(res: Response, lastEventId?: string): void {
    const since = Number(lastEventId);
    const resuming = Number.isFinite(since) && since > 0;
    const oldestHeld = this.buffer[0]?.offset ?? this.nextOffset;

    // A client is missing a prefix in two different situations, and both need
    // the same notice:
    //
    // - **Resuming** from an offset older than anything we still hold.
    // - **Connecting fresh** to a session whose beginning we have already
    //   discarded — a page reload after the buffer has rolled. This one is
    //   easy to miss because the client has no `lastEventId` to be wrong
    //   about; it simply starts mid-stream. Without the notice it receives a
    //   run of events for a thread it never saw created, drops every one of
    //   them, and renders an empty feed.
    const missingPrefix = resuming ? since + 1 < oldestHeld : oldestHeld > 1;
    if (missingPrefix) {
      res.write(
        `event: ${SSE_RESYNC_EVENT_NAME}\ndata: ${JSON.stringify({ from: oldestHeld })}\n\n`,
      );
    }

    for (const buffered of this.buffer) {
      if (!resuming || buffered.offset > since) res.write(formatFrame(buffered));
    }
  }

  /**
   * Comment-only heartbeat.
   *
   * Idle proxies and load balancers close connections that go quiet, and a
   * multiplexed feed can be legitimately idle for minutes. A `:` comment line
   * is invisible to `EventSource` consumers but keeps the socket warm.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeat || this.options.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      for (const subscriber of this.subscribers) subscriber.write(': heartbeat\n\n');
    }, this.options.heartbeatMs);
    // Never hold the process open for a heartbeat.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** Ends every subscriber connection. Used on shutdown and in tests. */
  close(): void {
    this.stopHeartbeat();
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
  }
}

/**
 * Serialises one buffered event as an SSE frame.
 *
 * Exported for the unit test: SSE framing is whitespace-sensitive in a way that
 * is easy to get subtly wrong and hard to debug through a browser.
 */
export function formatFrame({ offset, event }: BufferedEvent): string {
  return `id: ${offset}\nevent: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Owns the hubs, one per browser session. */
export class HubRegistry {
  private readonly hubs = new Map<string, SessionHub>();

  constructor(private readonly options: SessionHubOptions) {}

  get(sessionId: string): SessionHub {
    let hub = this.hubs.get(sessionId);
    if (!hub) {
      hub = new SessionHub(sessionId, this.options);
      this.hubs.set(sessionId, hub);
    }
    return hub;
  }

  closeAll(): void {
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
