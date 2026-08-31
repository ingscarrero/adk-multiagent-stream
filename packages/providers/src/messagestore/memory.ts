/**
 * Emulated message store: a Map of threadId to settled events.
 *
 * Unbounded on purpose. Retention is exactly what separates this from the event
 * stream, so a "bounded transcript store" would be the same mistake in a new
 * file. What it does not survive is a restart -- which is the half of L7 that a
 * Postgres adapter closes, and the reason this port exists rather than the
 * feature being written inline.
 */

import { isDurableEvent, type FeedEvent } from '@feed/protocol';
import type { MessageStore } from './port.ts';

export function memoryMessageStore(): MessageStore {
  const threads = new Map<string, FeedEvent[]>();

  return {
    mode: 'memory',

    append(threadId: string, event: FeedEvent) {
      if (!isDurableEvent(event)) return Promise.resolve();

      const existing = threads.get(threadId);
      if (!existing) {
        threads.set(threadId, [event]);
        return Promise.resolve();
      }

      // Idempotent by (threadId, seq). A replay must not double the transcript,
      // and `seq` is already the identity the rest of the system orders by --
      // inventing a second one here would be a second thing to keep correct.
      const at = existing.findIndex((stored) => stored.seq === event.seq);
      if (at === -1) existing.push(event);
      else existing[at] = event;

      // Written in seq order in practice; sorted anyway so a caller that
      // appends out of order cannot hand a reader a scrambled transcript.
      existing.sort((a, b) => a.seq - b.seq);
      return Promise.resolve();
    },

    transcript(threadId: string) {
      return Promise.resolve([...(threads.get(threadId) ?? [])]);
    },

    transcripts(threadIds: readonly string[]) {
      const out = new Map<string, FeedEvent[]>();
      for (const id of threadIds) {
        const events = threads.get(id);
        // Absent rather than empty: a caller needs to tell "nothing stored"
        // from "stored nothing".
        if (events) out.set(id, [...events]);
      }
      return Promise.resolve(out);
    },

    close() {
      threads.clear();
      return Promise.resolve();
    },
  };
}
