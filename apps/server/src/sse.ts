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
  /**
   * Bytes Node may queue for one subscriber before it is disconnected.
   *
   * `res.write` returns false when the kernel socket buffer is full, and Node
   * then queues the rest in process memory with no ceiling. A consumer that
   * stops reading -- a suspended laptop, a paused debugger, a phone that lost
   * signal without closing the socket -- grows that queue for as long as it
   * stays connected. See L2 in docs/LIMITATIONS.md.
   */
  maxBufferedBytes: number;
}

/** Everything belonging to one browser session's feed. */
export class SessionHub {
  private readonly subscribers = new Set<Response>();
  private heartbeat: NodeJS.Timeout | undefined;
  private evictedCount = 0;
  private lastActiveAt = Date.now();

  constructor(
    readonly sessionId: string,
    private readonly stream: EventStream,
    private readonly options: SessionHubOptions,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Subscribers disconnected for lagging. Diagnostic; see L2. */
  get evictedSubscriberCount(): number {
    return this.evictedCount;
  }

  /**
   * When this session last appended an event or accepted a subscriber.
   *
   * Read by {@link HubRegistry}'s sweeper. A thread still running with nobody
   * watching keeps its hub alive through `publish`, so a client that closed the
   * tab mid-run can come back to it.
   */
  get idleForMs(): number {
    return Date.now() - this.lastActiveAt;
  }

  /**
   * Appends an event to the session's stream.
   *
   * Delivery to live subscribers is the stream's job; this only has to await
   * the append so ordering is preserved when the stream is remote.
   */
  async publish(event: FeedEvent): Promise<StreamEntry> {
    this.lastActiveAt = Date.now();
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
      (entry) => this.writeTo(res, formatFrame(entry)),
    );

    this.writeResyncIfPrefixMissing(res, resuming ? since : null, subscription);
    for (const entry of subscription.replay) this.writeTo(res, formatFrame(entry));
    subscription.flush();

    this.subscribers.add(res);
    this.lastActiveAt = Date.now();
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
   * Writes one frame, and disconnects a subscriber that has stopped draining.
   *
   * `res.write` returning false is normal and not itself a problem -- it means
   * the socket buffer is full and Node has taken over queuing, which a healthy
   * consumer drains in milliseconds. The problem is a consumer that never
   * drains: nothing bounds that queue, so one stalled client grows server
   * memory for as long as it stays connected.
   *
   * `writableLength` is the size of that queue, so the ceiling goes there
   * rather than on the return value.
   *
   * **No resync is sent before disconnecting**, which is where this differs
   * from the fix originally sketched in L2. It would be futile and unnecessary:
   * futile because the frame joins the very queue being bounded, and
   * unnecessary because the reconnect handshake already computes the answer.
   * SSE frames are `\n\n`-delimited, so a half-written frame is discarded by
   * the parser and the browser's `Last-Event-ID` is the last *complete* frame.
   * Reconnecting from there either replays cleanly, if those offsets are still
   * retained, or trips {@link writeResyncIfPrefixMissing} if they are not.
   * Both outcomes are correct and neither needs help here.
   */
  private writeTo(res: Response, frame: string): void {
    if (res.writableEnded) return;
    res.write(frame);
    if (res.writableLength > this.options.maxBufferedBytes) this.evictLagging(res);
  }

  /**
   * Drops a subscriber that exceeded its buffer ceiling.
   *
   * `end()` closes the response, which makes Express emit `close` on the
   * request, which runs the detach returned by {@link subscribe} -- so the
   * subscription is released through the ordinary path rather than a second
   * one that could drift from it.
   */
  private evictLagging(res: Response): void {
    if (!this.subscribers.delete(res)) return;
    this.evictedCount += 1;
    if (this.subscribers.size === 0) this.stopHeartbeat();
    res.end();
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
      // Snapshot: writeTo can evict, and mutating the set mid-iteration is how
      // a heartbeat quietly starts skipping subscribers.
      for (const subscriber of [...this.subscribers]) this.writeTo(subscriber, ': heartbeat\n\n');
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

export interface HubRegistryOptions extends SessionHubOptions {
  /**
   * How long a hub with no subscribers may sit before it is swept.
   *
   * Generous on purpose: a reload, a tunnel, or a laptop lid is measured in
   * seconds to minutes, and sweeping a session someone is coming back to
   * costs them their history for no benefit.
   */
  idleTtlMs: number;
  /** How often to sweep. Zero disables it, which is what the tests want. */
  sweepIntervalMs: number;
}

/**
 * Owns the hubs, one per browser session, over a shared event stream.
 *
 * ## Why this sweeps, and why sweeping the hub is not enough
 *
 * Hubs are created on demand and every distinct `sessionId` -- every browser
 * tab, ever -- makes one. Retention bounds what is kept *per session*; nothing
 * bounded the number of sessions, so memory grew monotonically with unique
 * visitors (L3).
 *
 * The hub object is the small half. The events are the large half, and they
 * live in the {@link EventStream}, keyed by session, up to `EVENT_RETENTION`
 * each. So the sweep drops both: evicting the hub and leaving the log behind
 * would free a `Set` and a timer handle while the actual memory stayed.
 */
export class HubRegistry {
  private readonly hubs = new Map<string, SessionHub>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    private readonly stream: EventStream,
    private readonly options: HubRegistryOptions,
  ) {
    this.startSweeper();
  }

  get(sessionId: string): SessionHub {
    let hub = this.hubs.get(sessionId);
    if (!hub) {
      hub = new SessionHub(sessionId, this.stream, this.options);
      this.hubs.set(sessionId, hub);
    }
    return hub;
  }

  get size(): number {
    return this.hubs.size;
  }

  /**
   * Drops every hub that is idle and unwatched, and the session's log with it.
   *
   * Two conditions, both required. **No subscribers**, so nothing is reading;
   * because every subscriber's detach closes its subscription, a hub at zero
   * has no open subscriptions and `drop` gets the guarantee the port asks for.
   * **Idle past the TTL**, where `publish` counts as activity -- a thread still
   * running with nobody watching keeps its session alive, so closing a tab
   * mid-run does not throw the run away.
   *
   * Returns the number swept, so a test can assert on it rather than on timing.
   */
  async sweepIdle(): Promise<number> {
    const stale = [...this.hubs.values()].filter(
      (hub) => hub.subscriberCount === 0 && hub.idleForMs >= this.options.idleTtlMs,
    );
    for (const hub of stale) {
      hub.close();
      this.hubs.delete(hub.sessionId);
      await this.stream.drop(hub.sessionId);
    }
    return stale.length;
  }

  private startSweeper(): void {
    if (this.options.sweepIntervalMs <= 0) return;
    this.sweeper = setInterval(() => {
      // Nothing awaits this: a sweep failing must not take the process down,
      // and the next tick retries whatever it missed.
      void this.sweepIdle().catch(() => {});
    }, this.options.sweepIntervalMs);
    this.sweeper.unref?.();
  }

  closeAll(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
