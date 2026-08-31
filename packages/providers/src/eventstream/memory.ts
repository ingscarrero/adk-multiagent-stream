/**
 * Emulated event stream: a bounded array and a set of listeners, per session.
 *
 * This is what `SessionHub` did inline before the port existed. It is correct
 * for a single process and cannot work across instances: another instance holds
 * a different array, so a client that reconnects there finds nothing to replay.
 * That is the whole reason the real adapter exists.
 */

import type { FeedEvent } from '@feed/protocol';
import type { EventStream, StreamEntry, StreamSubscription } from './port.ts';

interface SessionState {
  entries: StreamEntry[];
  nextOffset: number;
  listeners: Set<(entry: StreamEntry) => void>;
}

export interface MemoryEventStreamOptions {
  /** Entries retained per session. Older ones are discarded. */
  retention: number;
}

export function memoryEventStream(options: MemoryEventStreamOptions): EventStream {
  const sessions = new Map<string, SessionState>();

  const stateOf = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { entries: [], nextOffset: 1, listeners: new Set() };
      sessions.set(sessionId, state);
    }
    return state;
  };

  return {
    mode: 'memory',

    append(sessionId: string, event: FeedEvent) {
      const state = stateOf(sessionId);
      const entry: StreamEntry = { offset: state.nextOffset++, event };

      state.entries.push(entry);
      if (state.entries.length > options.retention) {
        state.entries.splice(0, state.entries.length - options.retention);
      }

      // Retention is applied before delivery so a subscriber never sees an
      // entry the stream has already forgotten.
      for (const listener of state.listeners) listener(entry);
      return Promise.resolve(entry);
    },

    open(sessionId: string, afterOffset: number | null, onEntry) {
      const state = stateOf(sessionId);

      // Held until flush, so nothing appended while the caller writes the
      // backlog is lost or delivered out of order.
      let released = false;
      const pending: StreamEntry[] = [];
      const listener = (entry: StreamEntry) => {
        if (released) onEntry(entry);
        else pending.push(entry);
      };
      state.listeners.add(listener);

      const replay =
        afterOffset === null
          ? [...state.entries]
          : state.entries.filter((entry) => entry.offset > afterOffset);

      const subscription: StreamSubscription = {
        replay,
        oldestOffset: state.entries[0]?.offset ?? state.nextOffset,
        flush() {
          released = true;
          // An entry already in `replay` must not be delivered twice.
          const highest = replay.at(-1)?.offset ?? afterOffset ?? 0;
          for (const entry of pending) if (entry.offset > highest) onEntry(entry);
          pending.length = 0;
        },
        close() {
          state.listeners.delete(listener);
          return Promise.resolve();
        },
      };

      return Promise.resolve(subscription);
    },

    close() {
      sessions.clear();
      return Promise.resolve();
    },
  };
}
