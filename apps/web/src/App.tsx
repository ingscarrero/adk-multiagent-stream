/**
 * The feed shell: header, composer, and the list of threads.
 *
 * Deliberately thin. It owns layout and the two commands; every piece of state
 * it renders comes from `useFeedStream`, and every ordering decision was made
 * in the reducer before this component sees anything.
 */

import { useEffect, useState } from 'react';
import { Composer } from './feed/Composer.tsx';
import { ThreadCard } from './feed/ThreadCard.tsx';
import { useFeedStream } from './feed/useFeedStream.ts';
import { useStickyScroll } from './feed/useStickyScroll.ts';
import { activeThreadCount } from './feed/reducer.ts';

interface AgentOption {
  id: string;
  label: string;
  description: string;
}

/** Fallback used if `/api/health` is unreachable, so the UI is never empty. */
const FALLBACK_AGENTS: AgentOption[] = [
  { id: 'router', label: 'Support router', description: 'Delegates to a specialist.' },
  { id: 'research', label: 'Research pipeline', description: 'Parallel research, then synthesis.' },
];

export function App() {
  const { state, connection, lastError, startThread, cancelThread, followUp, respond } =
    useFeedStream();
  const [agents, setAgents] = useState<AgentOption[]>(FALLBACK_AGENTS);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { agents?: AgentOption[] } | null) => {
        if (!cancelled && body?.agents?.length) setAgents(body.agents);
      })
      .catch(() => {
        // The fallback list is already rendered; a failed health check should
        // not block the user from sending anything.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = activeThreadCount(state);
  /**
   * Counter readout, shown with `?debug` in the URL.
   *
   * `FeedState.stats` has always carried these; nothing displayed them, which
   * is why three separate recovery bugs were invisible in the running app and
   * had to be found by reading network frames. `droppedLossy` above zero means
   * the feed is missing something; `resyncs` climbing means recovery is looping
   * rather than settling.
   */
  const showDebug = new URLSearchParams(window.location.search).has('debug');
  const { ref, pinned, handleScroll, scrollToBottom } = useStickyScroll<HTMLDivElement>(
    state.stats.applied,
  );

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Agent Feed</h1>
          <p className="app__subtitle">
            Multiple agent threads, one stream, in order.
          </p>
        </div>
        <div className="app__meta">
          <span
            className={`connection connection--${connection}`}
            data-testid="connection-state"
            data-state={connection}
          >
            {connection === 'open' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
          <span className="app__count" data-testid="active-count">
            {active} active
          </span>
          {showDebug ? (
            <span className="app__debug" data-testid="debug-stats">
              <span data-testid="stat-applied">applied {state.stats.applied}</span>
              <span data-testid="stat-buffered">buffered {state.stats.buffered}</span>
              <span data-testid="stat-redundant">redundant {state.stats.droppedRedundant}</span>
              <span
                data-testid="stat-lossy"
                className={state.stats.droppedLossy > 0 ? 'app__debug--alert' : ''}
              >
                lossy {state.stats.droppedLossy}
              </span>
              <span data-testid="stat-resyncs">resyncs {state.stats.resyncs}</span>
            </span>
          ) : null}
        </div>
      </header>

      <main className="app__main">
        {/* `role="log"` marks this as an append-only region. It is NOT
            `aria-live`: each thread announces its own status, so a feed-level
            live region would double every announcement. */}
        <div
          className="feed"
          ref={ref}
          onScroll={handleScroll}
          role="log"
          aria-label="Agent threads"
          data-testid="feed"
        >
          {state.order.length === 0 ? (
            <p className="feed__empty" data-testid="feed-empty">
              No threads yet. Send a message, then send another before the first finishes.
            </p>
          ) : null}

          {state.order.map((threadId) => {
            const thread = state.threads[threadId];
            return thread ? (
              <ThreadCard
                key={threadId}
                thread={thread}
                onCancel={(id) => void cancelThread(id)}
                onFollowUp={(id, prompt) => void followUp(id, prompt)}
                onRespond={(id, requestId, approved) => void respond(id, requestId, approved)}
              />
            ) : null;
          })}
        </div>

        {!pinned ? (
          <button
            type="button"
            className="button button--jump"
            data-testid="jump-to-latest"
            onClick={scrollToBottom}
          >
            Jump to latest
          </button>
        ) : null}
      </main>

      <footer className="app__footer">
        {lastError ? (
          <p className="app__error" role="alert" data-testid="composer-error">
            {lastError}
          </p>
        ) : null}
        <Composer agents={agents} onSubmit={(prompt, agent) => void startThread(prompt, agent)} />
      </footer>
    </div>
  );
}
