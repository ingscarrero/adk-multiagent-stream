/**
 * The per-session event stream: append-only, retained for a window, replayable
 * from an offset, and subscribable for what comes next.
 *
 * ## Why one port and not two
 *
 * An earlier catalogue listed `eventLog` and `fanout` separately &mdash; storage
 * and delivery. They are two concerns, but not two seams: only two of the four
 * combinations are coherent. An in-memory log with shared delivery is broken
 * (an instance that never held the events cannot replay them to a client that
 * reconnects there), and a shared log with in-process delivery works but buys
 * nothing. Every real provider supplies both from one primitive &mdash; Redis
 * Streams is `XADD` / `XRANGE` / `XREAD BLOCK`, Kafka is a topic you produce to
 * and consume from &mdash; so splitting them would model a seam no
 * implementation has.
 *
 * "Fan-out" is also already taken in this repo: it means a `ParallelAgent`
 * running its children concurrently.
 *
 * ## The open/flush shape
 *
 * `open` looks unusual and the alternative is a race. A subscriber needs the
 * backlog *and* everything after it, with nothing lost in between. Calling
 * `replay()` and then `subscribe()` drops any event that lands between the two.
 * So `open` registers the listener and snapshots the backlog together, holding
 * live events until the caller has written the backlog and calls `flush`.
 */

import type { FeedEvent } from '@feed/protocol';

/** An event with the offset the stream assigned it. Offsets start at 1. */
export interface StreamEntry {
  offset: number;
  event: FeedEvent;
}

export interface StreamSubscription {
  /**
   * Entries at or before the subscriber's requested point that are still
   * retained. Written by the caller before `flush`.
   */
  readonly replay: StreamEntry[];
  /**
   * The oldest offset the stream still holds for this session.
   *
   * This is what overrun detection needs: a subscriber whose resume point is
   * below it has lost a prefix and must be told to resync.
   */
  readonly oldestOffset: number;
  /** Releases live entries held during `open`. Call after writing `replay`. */
  flush(): void;
  close(): Promise<void>;
}

export interface EventStream {
  readonly mode: string;
  /** Appends an event and returns it with its assigned offset. */
  append(sessionId: string, event: FeedEvent): Promise<StreamEntry>;
  /**
   * Subscribes from just after `afterOffset`, or from the oldest retained
   * entry when it is null. Live entries are held until `flush`.
   */
  open(
    sessionId: string,
    afterOffset: number | null,
    onEntry: (entry: StreamEntry) => void,
  ): Promise<StreamSubscription>;
  close(): Promise<void>;
}
