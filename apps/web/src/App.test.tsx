/**
 * App shell tests.
 *
 * The shell is thin by design, so these pin only what it owns: the empty
 * state, the connection readout, the agent list arriving from `/api/health`,
 * and the `?debug` counters that make recovery observable by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.tsx';

/** The minimum `EventSource` surface the stream hook touches. */
class IdleEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = IdleEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(): void {}
  close(): void {
    this.readyState = IdleEventSource.CLOSED;
  }
}

const health = (agents: Array<{ id: string; label: string; description: string }>) =>
  vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ agents }) });

beforeEach(() => {
  vi.stubGlobal('EventSource', IdleEventSource);
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the empty feed and a connecting readout before any stream event', () => {
    vi.stubGlobal('fetch', health([]));
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Agent Feed' })).toBeInTheDocument();
    expect(screen.getByTestId('feed-empty')).toBeInTheDocument();
    expect(screen.getByTestId('active-count')).toHaveTextContent('0 active');
    expect(screen.getByTestId('connection-state')).toHaveAttribute('data-state', 'connecting');
  });

  it('marks the feed as an append-only log with an accessible name', () => {
    vi.stubGlobal('fetch', health([]));
    render(<App />);
    expect(screen.getByRole('log', { name: 'Agent threads' })).toBeInTheDocument();
  });

  it('replaces the fallback agent list with the one the server reports', async () => {
    // The selected agent stays `router`; the server's copy of it is what must
    // win, and an agent the fallback never had must appear.
    vi.stubGlobal(
      'fetch',
      health([
        { id: 'router', label: 'Server router', description: 'From the server.' },
        { id: 'custom', label: 'Custom agent', description: 'Also from the server.' },
      ]),
    );
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Custom agent' })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'Server router' })).toBeInTheDocument();
    expect(screen.getByTestId('agent-description')).toHaveTextContent('From the server.');
  });

  it('keeps the fallback agents when the health check fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<App />);

    // Give the rejected promise a tick to settle; the list must survive it.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Support router' })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'Research pipeline' })).toBeInTheDocument();
  });

  it('hides the counters by default and shows them with ?debug', () => {
    vi.stubGlobal('fetch', health([]));
    const { unmount } = render(<App />);
    expect(screen.queryByTestId('debug-stats')).not.toBeInTheDocument();
    unmount();

    window.history.replaceState({}, '', '/?debug');
    render(<App />);
    expect(screen.getByTestId('debug-stats')).toBeInTheDocument();
    expect(screen.getByTestId('stat-applied')).toHaveTextContent('applied 0');
    expect(screen.getByTestId('stat-lossy')).toHaveTextContent('lossy 0');
    expect(screen.getByTestId('stat-resyncs')).toHaveTextContent('resyncs 0');
  });
});
