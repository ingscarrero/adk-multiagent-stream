/**
 * The multiplexed SSE transport.
 *
 * One HTTP connection per browser session carries the events of *every* thread
 * in that session. See docs/STREAMING-CONTRACT.md for why this shape was chosen
 * over one connection per thread.
 *
 * ## What this file owns, and what it delegates
 *
 * It owns the parts that are about **SSE**: response headers, the priming
 * frame, frame formatting, the overrun notice, the heartbeat, and subscriber
 * teardown.
 *
 * It no longer owns storage or delivery. Those are the {@link EventStream}
 * provider: appending with an offset, retaining a window, replaying from a
 * resume point, and pushing what comes next. In-process that is an array and a
 * set of listeners; across instances it is Redis Streams. This file cannot tell
 * the difference, which is the point.
 *
 * ## Two counters, deliberately
 *
 * - **`seq`** (on the event, assigned by `ThreadRunner`) is *per thread* and
 *   expresses ordering: what happened in what order within a thread.
 * - **`offset`** (assigned by the event stream) is *per session* and exists for
 *   transport resume: it is what a reconnecting browser sends back in
 *   `Last-Event-ID`.
 *
 * Conflating them is the classic bug. A global counter cannot express
 * per-thread ordering once threads interleave, and a per-thread counter cannot
 * drive `Last-Event-ID` on a shared connection.
 */

import type { Response } from 'express';
import { SSE_EVENT_NAME, SSE_RESYNC_EVENT_NAME, type FeedEvent } from '@feed/protocol';
import type { EventStream, StreamEntry, StreamSubscription } from '@feed/providers';

export interface SessionHubOptions {
  heartbeatMs: number;
  /** Reconnect backoff advertised to the browser via the SSE `retry:` field. */
  reconnectDelayMs: number;
}

/** Everything belonging to one browser session's feed. */
export class SessionHub {
  private readonly subscribers = new Set<Response>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    readonly sessionId: string,
    private readonly stream: EventStream,
    private readonly options: SessionHubOptions,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Appends an event to the session's stream.
   *
   * Delivery to live subscribers is the stream's job; this only has to await
   * the append so ordering is preserved when the stream is remote.
   */
  async publish(event: FeedEvent): Promise<StreamEntry> {
    return this.stream.append(this.sessionId, event);
  }

  /**
   * Attaches a response as an SSE subscriber.
   *
   * @param lastEventId The client's `Last-Event-ID`, if it is reconnecting.
   * @returns A detach function; call it on connection close.
   */
  async subscribe(res: Response, lastEventId?: string): Promise<() => void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer proxied responses by default, which turns a
      // token stream into one big delivery at the end.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Then write an actual byte, immediately.
    //
    // `flushHeaders` only flushes *this* response. Any intermediary -- a dev
    // proxy, nginx, a load balancer -- has its own outbound response, and Node
    // does not put those headers on the wire until something writes a body
    // chunk. On an idle feed the first chunk could be a heartbeat 15 seconds
    // later, during which the browser's EventSource sits in CONNECTING and
    // never fires `onopen`. A comment frame costs nothing and makes the
    // handshake complete through every hop.
    //
    // `retry:` sets the browser's reconnect backoff at the same time, which is
    // otherwise a browser-specific default we have no control over.
    res.write(`retry: ${this.options.reconnectDelayMs}\n: connected\n\n`);

    const since = Number(lastEventId);
    const resuming = Number.isFinite(since) && since > 0;

    // `open` snapshots the backlog and registers for what follows in one step.
    // Doing it as two calls would drop anything appended in between.
    const subscription = await this.stream.open(
      this.sessionId,
      resuming ? since : null,
      (entry) => res.write(formatFrame(entry)),
    );

    this.writeResyncIfPrefixMissing(res, resuming ? since : null, subscription);
    for (const entry of subscription.replay) res.write(formatFrame(entry));
    subscription.flush();

    this.subscribers.add(res);
    this.ensureHeartbeat();

    return () => {
      this.subscribers.delete(res);
      void subscription.close();
      if (this.subscribers.size === 0) this.stopHeartbeat();
    };
  }

  /**
   * Tells a client it is missing the start of the session.
   *
   * Two situations need the same notice, and the second is easy to overlook:
   *
   * - **Resuming** from an offset older than anything still retained.
   * - **Connecting fresh** to a session whose beginning has already rolled out
   *   -- a page reload after a long or busy session. That client has no stale
   *   offset to be wrong about; it simply starts in the middle. Without the
   *   notice it receives events for threads it never saw created, drops every
   *   one of them, and renders an empty feed.
   *
   * `from` is a resume point, not decoration: the client comes back at
   * `from - 1`, which replays the same backlog and satisfies the check below,
   * so recovery settles after one round trip instead of looping.
   */
  private writeResyncIfPrefixMissing(
    res: Response,
    since: number | null,
    subscription: StreamSubscription,
  ): void {
    const oldest = subscription.oldestOffset;
    const missingPrefix = since === null ? oldest > 1 : since + 1 < oldest;
    if (!missingPrefix) return;

    res.write(
      `event: ${SSE_RESYNC_EVENT_NAME}\ndata: ${JSON.stringify({ from: oldest })}\n\n`,
    );
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
 * Serialises one entry as an SSE frame.
 *
 * Exported for the unit test: SSE framing is whitespace-sensitive in a way that
 * is easy to get subtly wrong and hard to debug through a browser. It is safe
 * by construction because `JSON.stringify` cannot emit a literal newline, so no
 * payload can split the envelope.
 */
export function formatFrame({ offset, event }: StreamEntry): string {
  return `id: ${offset}\nevent: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Owns the hubs, one per browser session, over a shared event stream. */
export class HubRegistry {
  private readonly hubs = new Map<string, SessionHub>();

  constructor(
    private readonly stream: EventStream,
    private readonly options: SessionHubOptions,
  ) {}

  get(sessionId: string): SessionHub {
    let hub = this.hubs.get(sessionId);
    if (!hub) {
      hub = new SessionHub(sessionId, this.stream, this.options);
      this.hubs.set(sessionId, hub);
    }
    return hub;
  }

  closeAll(): void {
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
