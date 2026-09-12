/**
 * The React binding for the feed.
 *
 * Deliberately thin. All ordering logic lives in `reducer.ts`; this hook only
 * owns the things React has to own — the `EventSource` lifecycle, the session
 * identity, and the two commands the UI can issue.
 *
 * ## Why `EventSource` rather than `fetch` + `ReadableStream`
 *
 * `EventSource` reconnects on its own and replays `Last-Event-ID` for us, which
 * is the entire reconnect story handled by the platform. The cost is that it
 * cannot send custom headers, which is why `sessionId` travels as a query
 * parameter and why the dev server proxies `/api` to keep everything
 * same-origin. See docs/STREAMING-CONTRACT.md.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  SSE_EVENT_NAME,
  SSE_RESYNC_EVENT_NAME,
  safeParseFeedEvent,
  safeParseResyncNotice,
  threadsSnapshotSchema,
} from '@feed/protocol';
import { eventAction, feedReducer, initialFeedState, resyncAction, type FeedState } from './reducer.ts';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

const SESSION_STORAGE_KEY = 'feed.sessionId';

/** Backoff before we re-create an `EventSource` the browser has given up on. */
const RECONNECT_DELAY_MS = 1000;

/**
 * A stable per-tab session id.
 *
 * Persisted in `sessionStorage` so a page reload resumes the same feed and
 * replays its history, and scoped per tab so two tabs are two independent
 * feeds. Wrapped in try/catch because storage throws outright in some privacy
 * modes, where an ephemeral id is a perfectly good fallback.
 */
function loadSessionId(): string {
  const fresh = () =>
    (globalThis.crypto?.randomUUID?.() ?? `s-${Math.random().toString(36).slice(2)}`);
  try {
    const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) return stored;
    const created = fresh();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return fresh();
  }
}

export interface UseFeedStream {
  state: FeedState;
  sessionId: string;
  connection: ConnectionState;
  /** Last command error, surfaced in the composer rather than thrown. */
  lastError: string | null;
  startThread: (prompt: string, agent: string) => Promise<void>;
  cancelThread: (threadId: string) => Promise<void>;
  /** Sends a follow-up into an existing thread. */
  followUp: (threadId: string, prompt: string) => Promise<void>;
  /** Answers a human-input request the thread is paused on. */
  respond: (threadId: string, requestId: string, approved: boolean) => Promise<void>;
}

export function useFeedStream(): UseFeedStream {
  const [state, dispatch] = useReducer(feedReducer, initialFeedState);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [lastError, setLastError] = useState<string | null>(null);
  // Computed once per mount. Because it is stable, the callbacks below can
  // simply depend on it — no ref, and nothing written during render.
  const sessionId = useMemo(() => loadSessionId(), []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    /**
     * The last SSE `id:` we received.
     *
     * The browser replays `Last-Event-ID` automatically, but only for a
     * connection it retried itself. When *we* create a new `EventSource` (see
     * below) that history is gone, so we resume via the query parameter the
     * server also accepts.
     */
    let lastEventId = '';

    /**
     * Rebuilds from `GET /api/threads` after an unreachable resume point.
     *
     * Ordering matters here. The stream is torn down *first* so no event can
     * land between the snapshot being taken and being applied, and the
     * reconnect deliberately omits `lastEventId` so the server replays its
     * whole buffer. Replayed events at or below each thread's snapshot
     * `lastSeq` are then dropped as redundant, and anything above continues
     * contiguously -- which is exactly the behaviour the gates already have.
     */
    const resync = async (resumeFrom: number | null) => {
      if (disposed) return;
      source?.close();
      source = null;

      // Resume from the oldest offset the server still holds, which is exactly
      // what the notice's `from` field is for.
      //
      // Reconnecting with no resume point at all looks tempting -- "replay
      // everything you have" -- and loops forever: the server's overrun test is
      // `oldestHeld > 1` for a client with no offset, which is still true the
      // moment we come back, so it sends another resync, and so on. Asking for
      // `from - 1` gets the identical replay AND satisfies the resuming test
      // (`since + 1 < oldestHeld` is false), so the loop terminates after one
      // round trip.
      lastEventId = resumeFrom !== null && resumeFrom > 1 ? String(resumeFrom - 1) : '';

      try {
        const response = await fetch(
          `/api/threads?sessionId=${encodeURIComponent(sessionId)}`,
          { headers: { 'x-session-id': sessionId } },
        );
        if (response.ok) {
          const snapshot = threadsSnapshotSchema.safeParse(await response.json());
          if (snapshot.success) dispatch(resyncAction(snapshot.data.threads));
        }
      } catch {
        // A failed snapshot is not fatal: reconnecting still recovers whatever
        // is left in the buffer, and the next overrun will try again.
      }

      connect();
    };

    const connect = () => {
      if (disposed) return;

      const params = new URLSearchParams({ sessionId });
      if (lastEventId) params.set('lastEventId', lastEventId);
      source = new EventSource(`/api/stream?${params.toString()}`);

      source.onopen = () => setConnection('open');

      source.onerror = () => {
        setConnection('reconnecting');

        // Browsers do not agree on how long to keep trying. Chromium retries a
        // dropped stream indefinitely; Firefox gives up on some failures and
        // parks the connection in CLOSED, where nothing will ever reopen it.
        // Retrying ourselves in that case is the difference between a feed that
        // recovers on every engine and one that recovers only on Chrome.
        if (source?.readyState === EventSource.CLOSED && !disposed) {
          source.close();
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      /**
       * The server could not resume us from where we asked.
       *
       * Everything between our last event and the buffer's oldest is gone, and
       * some threads may have lost their `thread.created` entirely -- which the
       * reducer would otherwise drop forever. Rebuilding from the snapshot is
       * the only way back, so we take it before consuming any more of the
       * stream.
       */
      source.addEventListener(SSE_RESYNC_EVENT_NAME, (message) => {
        const notice = safeParseResyncNotice(
          safeJsonParse((message as MessageEvent<string>).data),
        );
        void resync(notice ? notice.from : null);
      });

      source.addEventListener(SSE_EVENT_NAME, (message) => {
        const event = message as MessageEvent<string>;
        if (event.lastEventId) lastEventId = event.lastEventId;

        const parsed = safeParseFeedEvent(safeJsonParse(event.data));
        // A frame we cannot parse is dropped rather than allowed to tear down
        // the stream — one bad event must not cost the user the rest of the feed.
        // Replays are harmless: the reducer drops sequence numbers it has seen.
        if (parsed) dispatch(eventAction(parsed));
      });
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [sessionId]);

  const startThread = useCallback(async (prompt: string, agent: string) => {
    setLastError(null);
    try {
      const response = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({ prompt, agent }),
      });
      if (!response.ok) {
        setLastError(`Could not start thread (${response.status})`);
      }
      // No state update on success: the thread arrives on the stream like
      // everything else, so there is exactly one path into the reducer.
    } catch {
      setLastError('Could not reach the server.');
    }
  }, [sessionId]);

  const cancelThread = useCallback(async (threadId: string) => {
    setLastError(null);
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/cancel`, {
        method: 'POST',
        headers: { 'x-session-id': sessionId },
      });
      // The server answers 400 (no session), 404 (not this session's thread)
      // or 409 (already finished); fetch only rejects on transport errors.
      if (!response.ok) {
        setLastError(`Could not cancel the thread (${response.status})`);
      }
    } catch {
      setLastError('Could not reach the server.');
    }
  }, [sessionId]);

  // Both of these follow `startThread`'s shape exactly: POST, report a failure
  // to accept, and update nothing locally. The consequences arrive on the
  // stream, so the reducer still has exactly one input.
  const followUp = useCallback(
    async (threadId: string, prompt: string) => {
      setLastError(null);
      try {
        const response = await fetch(
          `/api/threads/${encodeURIComponent(threadId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
            body: JSON.stringify({ prompt }),
          },
        );
        if (!response.ok) setLastError(`Could not send the follow-up (${response.status})`);
      } catch {
        setLastError('Could not reach the server.');
      }
    },
    [sessionId],
  );

  const respond = useCallback(
    async (threadId: string, requestId: string, approved: boolean) => {
      setLastError(null);
      try {
        const response = await fetch(
          `/api/threads/${encodeURIComponent(threadId)}/respond`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
            body: JSON.stringify({ requestId, approved }),
          },
        );
        if (!response.ok) setLastError(`Could not send your decision (${response.status})`);
      } catch {
        setLastError('Could not reach the server.');
      }
    },
    [sessionId],
  );

  return {
    state,
    sessionId,
    connection,
    lastError,
    startThread,
    cancelThread,
    followUp,
    respond,
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
