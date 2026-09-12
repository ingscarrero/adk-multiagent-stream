/**
 * Tests for the stream hook's recovery wiring.
 *
 * The reducer tests prove the resync *action* rebuilds state correctly; these
 * prove the hook actually dispatches one when the server asks. That seam is
 * where L1 lived: the server half worked, the reducer half would have worked,
 * and nothing connected them.
 *
 * `EventSource` does not exist in jsdom, so a minimal stand-in is installed
 * here. It implements only what the hook touches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SSE_EVENT_NAME, SSE_RESYNC_EVENT_NAME, type ThreadSummary } from '@feed/protocol';
import { useFeedStream } from './useFeedStream.ts';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every instance created during a test, in order. */
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Test helper: deliver a frame to the registered listeners. */
  emit(type: string, data: unknown, lastEventId = ''): void {
    const event = { data: JSON.stringify(data), lastEventId } as MessageEvent<string>;
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
}

const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: 'thr-1',
  prompt: 'where is my order?',
  agent: 'router',
  status: 'complete',
  createdAt: 1_700_000_000_000,
  lastSeq: 12,
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);

  // Written with explicit promises rather than `async` bodies: there is nothing
  // to await in a stub, and `require-await` is right to say so.
  const respond = (body: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

  fetchMock = vi.fn((input: string) =>
    input.startsWith('/api/threads?') ? respond({ threads: [summary()] }) : respond({}),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const latest = () => FakeEventSource.instances.at(-1)!;

describe('connection lifecycle', () => {
  it('opens a stream carrying the session id', () => {
    renderHook(() => useFeedStream());
    expect(latest().url).toContain('/api/stream?sessionId=');
  });

  it('reports open once the stream connects', async () => {
    const { result } = renderHook(() => useFeedStream());
    act(() => latest().open());
    await waitFor(() => expect(result.current.connection).toBe('open'));
  });

  it('applies feed frames through the reducer', async () => {
    const { result } = renderHook(() => useFeedStream());
    act(() =>
      latest().emit(SSE_EVENT_NAME, {
        type: 'thread.created',
        threadId: 'thr-1',
        seq: 1,
        ts: 1,
        prompt: 'hello',
        agent: 'router',
      }),
    );
    await waitFor(() => expect(result.current.state.order).toEqual(['thr-1']));
  });

  it('ignores a malformed frame instead of tearing down the stream', async () => {
    const { result } = renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_EVENT_NAME, { type: 'nonsense' }));
    await waitFor(() => expect(result.current.state.order).toEqual([]));
    expect(latest().closed).toBe(false);
  });
});

describe('resync recovery (L1)', () => {
  it('fetches the snapshot when the server reports an unreachable resume point', async () => {
    renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/threads?sessionId='),
        expect.anything(),
      ),
    );
  });

  it('rebuilds the missing thread from the snapshot', async () => {
    const { result } = renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));

    await waitFor(() => expect(result.current.state.order).toEqual(['thr-1']));
    const thread = result.current.state.threads['thr-1']!;
    expect(thread.prompt).toBe('where is my order?');
    // The snapshot does not set a watermark: the thread waits to learn from the
    // replay how much of its history is actually missing.
    expect(thread.awaitingResume).toBe(true);
    expect(thread.historyTruncated).toBe(true);
    expect(result.current.state.stats.resyncs).toBe(1);
  });

  it('tears the old stream down and opens a fresh one', async () => {
    // Ordering matters: nothing may arrive between the snapshot being taken and
    // being applied, so the stream is closed before the fetch.
    renderHook(() => useFeedStream());
    const original = latest();
    act(() => original.emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(original.closed).toBe(true);
  });

  it('resumes from the offset the notice names, which is what stops it looping', async () => {
    // Regression, and a nasty one. Reconnecting with no resume point looks
    // right -- "replay everything you have" -- but the server's overrun test
    // for a client with no offset is `oldestHeld > 1`, which is still true the
    // instant we come back. It sends another resync, we tear down again, and
    // the stream never stays up: live events for new threads never land.
    //
    // Asking for `from - 1` gets the same replay and satisfies the resuming
    // test, so the loop ends after one round trip.
    renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(latest().url).toContain('lastEventId=39');
  });

  it('falls back to no resume point when the notice is unreadable', async () => {
    renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { nonsense: true }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(latest().url).not.toContain('lastEventId');
  });

  it('does not reconnect in a loop when the server keeps reporting an overrun', async () => {
    // Each notice must produce exactly one reconnect, not a cascade.
    renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    // Give any runaway loop a chance to show itself.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('still reconnects when the snapshot request fails', async () => {
    // A failed snapshot is not fatal; reconnecting recovers whatever the buffer
    // still holds, and the next overrun tries again.
    // `mockRejectedValue` keeps the rejection out of an argument position, which
    // is what `no-misused-promises` objects to.
    fetchMock.mockRejectedValue(new Error('offline'));

    renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  });

  it('lets live events land contiguously after recovery', async () => {
    const { result } = renderHook(() => useFeedStream());
    act(() => latest().emit(SSE_RESYNC_EVENT_NAME, { from: 40 }));
    await waitFor(() => expect(result.current.state.order).toEqual(['thr-1']));

    // The replay picks up at seq 13, above the thread's start, so the client
    // accepts the jump and records that a prefix was missed.
    act(() =>
      latest().emit(SSE_EVENT_NAME, {
        type: 'message.delta',
        threadId: 'thr-1',
        seq: 13,
        ts: 2,
        messageId: 'm1',
        author: 'order_agent',
        delta: 'resumed',
      }),
    );

    await waitFor(() =>
      expect(result.current.state.threads['thr-1']?.messages['m1']?.text).toBe('resumed'),
    );
    expect(result.current.state.stats.droppedLossy).toBe(0);
  });
});

describe('cancelThread', () => {
  it('sends the session id so the server can enforce thread ownership', async () => {
    const { result } = renderHook(() => useFeedStream());
    await act(() => result.current.cancelThread('thread-1'));
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/threads/thread-1/cancel'));
    expect(call).toBeDefined();
    const [, init] = call as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-session-id']).toEqual(expect.any(String));
    expect((init.headers as Record<string, string>)['x-session-id']).not.toHaveLength(0);
  });

  it('surfaces a transport failure in lastError instead of throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useFeedStream());
    await act(() => result.current.cancelThread('thread-1'));
    expect(result.current.lastError).toBe('Could not reach the server.');
  });

  it('surfaces a rejected cancel (404 for another session\'s thread) instead of treating it as success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });
    const { result } = renderHook(() => useFeedStream());
    await act(() => result.current.cancelThread('thread-1'));
    expect(result.current.lastError).toBe('Could not cancel the thread (404)');
  });
});
