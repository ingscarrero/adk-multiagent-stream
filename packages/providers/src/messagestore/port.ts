/**
 * The durable transcript: what a thread said, kept indefinitely, read by key.
 *
 * ## Why this is not the event stream wearing a different hat
 *
 * Both hold `FeedEvent`s, and that similarity hides the difference that
 * matters. The {@link EventStream} answers *what happened next* over a
 * retention window, addressed by offset, and forgets. This answers *what is
 * this thread* by id, and does not. Retention is the distinguishing property,
 * not the shape of the record.
 *
 * Conflating them is the one architectural mistake this repo shipped: the log
 * was also the store, so a transcript expired with the replay window and the
 * recovery endpoint had nothing to return but an apology. See
 * docs/ARCHITECTURE.md.
 *
 * ## Settle points only
 *
 * `message.delta` is never stored, and that is the whole economy of this
 * design. A delta is a transport artefact -- "the fourth chunk of the second
 * message" is worthless the instant `message.complete` lands, and its entire
 * value was showing text before it was finished. Storing settled events only is
 * roughly five writes per turn instead of twenty-three, and the transcript that
 * comes back is the same events the reducer already knows how to apply.
 *
 * {@link isDurableEvent} is the predicate, and it lives in `@feed/protocol` so
 * the two halves cannot disagree about what durable means.
 *
 * ## What it deliberately does not have
 *
 * No `drop(sessionId)`. The event stream has one, because a session's live
 * window is scratch space that should be reclaimed when nobody is watching. A
 * transcript outliving the session that produced it is the point of having one.
 */

import type { FeedEvent } from '@feed/protocol';

export interface MessageStore {
  readonly mode: string;
  /**
   * Records one settled event.
   *
   * Callers pass every event and this ignores the ones that are not durable,
   * rather than making each call site remember the rule. A store that silently
   * accepted a delta would be a store that silently grew twenty-three times
   * faster than intended.
   */
  append(threadId: string, event: FeedEvent): Promise<void>;
  /** Every stored event for one thread, in `seq` order. */
  transcript(threadId: string): Promise<FeedEvent[]>;
  /**
   * Transcripts for many threads at once.
   *
   * The recovery path needs every thread in a session, and one round trip
   * beats N. Threads with nothing stored are absent from the result rather
   * than present and empty, so a caller can tell "no transcript" from "an
   * empty one".
   */
  transcripts(threadIds: readonly string[]): Promise<Map<string, FeedEvent[]>>;
  close(): Promise<void>;
}
