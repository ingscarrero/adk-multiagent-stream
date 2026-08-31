/**
 * Adapter tests, written against hand-built ADK events.
 *
 * Hand-building the fixtures (rather than recording a live run) is the point:
 * each test states one ADK behaviour we depend on, so a reader can see the
 * assumption and a future ADK upgrade breaks a named test rather than the app.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@google/adk';
import { AdkEventTranslator, resetMessageIds, type FeedEventDraft } from './adk-adapter.ts';

/** Builds a minimal ADK Event; only the fields the adapter reads are set. */
function adkEvent(partial: Partial<Event>): Event {
  return {
    id: 'e1',
    invocationId: 'inv1',
    author: 'agent',
    actions: {},
    timestamp: 0,
    ...partial,
  } as Event;
}

const text = (author: string, value: string, isPartial = false) =>
  adkEvent({
    author,
    content: { role: 'model', parts: [{ text: value }] },
    ...(isPartial ? { partial: true } : {}),
  });

const types = (drafts: FeedEventDraft[]) => drafts.map((d) => d.type);

beforeEach(() => resetMessageIds());

describe('text streaming', () => {
  it('turns partial events into deltas and the final event into a complete', () => {
    const t = new AdkEventTranslator('running');

    expect(types(t.translate(text('a', 'Hel', true)))).toEqual(['thread.status', 'message.delta']);
    expect(types(t.translate(text('a', 'lo', true)))).toEqual(['message.delta']);

    const final = t.translate(text('a', 'Hello'));
    expect(final).toEqual([{ type: 'message.complete', messageId: 'msg-1', author: 'a', text: 'Hello' }]);
  });

  it('reuses the open messageId so the client replaces instead of appending', () => {
    const t = new AdkEventTranslator('running');
    t.translate(text('a', 'Hel', true));
    const [complete] = t.translate(text('a', 'Hello'));

    // Same id as the deltas: the client swaps its accumulated text for the
    // authoritative version rather than rendering the message twice.
    expect(complete).toMatchObject({ type: 'message.complete', messageId: 'msg-1' });
  });

  it('mints a fresh messageId for a message that never streamed', () => {
    const t = new AdkEventTranslator('running');
    const [complete] = t.translate(text('a', 'One shot'));
    expect(complete).toMatchObject({ messageId: 'msg-1' });
  });
});

describe('concurrent authors', () => {
  it('keeps two interleaved agents in separate messages', () => {
    // The ParallelAgent case. A single accumulator here would splice the two
    // agents' words into one scrambled message.
    const t = new AdkEventTranslator('running');

    t.translate(text('market', 'Market says', true));
    t.translate(text('docs', 'Docs say', true));
    t.translate(text('market', ' fast shipping', true));
    t.translate(text('docs', ' 30 day returns', true));

    const marketDone = t.translate(text('market', 'Market says fast shipping'));
    const docsDone = t.translate(text('docs', 'Docs say 30 day returns'));

    expect(marketDone[0]).toMatchObject({ messageId: 'msg-1', author: 'market' });
    expect(docsDone[0]).toMatchObject({ messageId: 'msg-2', author: 'docs' });
  });
});

describe('tools', () => {
  it('emits tool.call and moves the thread to awaiting_tool', () => {
    const t = new AdkEventTranslator('running');
    const drafts = t.translate(
      adkEvent({
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'c1', name: 'lookupOrder', args: { orderId: 'A-1' } } }],
        },
      }),
    );

    expect(drafts).toEqual([
      { type: 'tool.call', callId: 'c1', name: 'lookupOrder', args: { orderId: 'A-1' } },
      { type: 'thread.status', status: 'awaiting_tool' },
    ]);
  });

  it('emits tool.result and returns the thread to running', () => {
    const t = new AdkEventTranslator('awaiting_tool');
    const drafts = t.translate(
      adkEvent({
        content: {
          role: 'user',
          parts: [{ functionResponse: { id: 'c1', name: 'lookupOrder', response: { found: true } } }],
        },
      }),
    );

    expect(drafts).toEqual([
      { type: 'tool.result', callId: 'c1', name: 'lookupOrder', result: { found: true } },
      { type: 'thread.status', status: 'running' },
    ]);
  });

  it('correlates result to call by callId', () => {
    const t = new AdkEventTranslator('running');
    const [call] = t.translate(
      adkEvent({ content: { role: 'model', parts: [{ functionCall: { id: 'c9', name: 'x', args: {} } }] } }),
    );
    const [result] = t.translate(
      adkEvent({ content: { role: 'user', parts: [{ functionResponse: { id: 'c9', name: 'x', response: {} } }] } }),
    );
    expect((call as { callId: string }).callId).toBe((result as { callId: string }).callId);
  });

  it('surfaces transfer_to_agent as a visible tool call', () => {
    // A handoff is meaningful to a reader, so it is rendered rather than hidden.
    const t = new AdkEventTranslator('running');
    const drafts = t.translate(
      adkEvent({
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 't1', name: 'transfer_to_agent', args: { agentName: 'kb' } } }],
        },
      }),
    );
    expect(drafts[0]).toMatchObject({ type: 'tool.call', name: 'transfer_to_agent' });
  });

  it('treats an adk_request_* call as awaiting_input, not as a tool', () => {
    const t = new AdkEventTranslator('running');
    const drafts = t.translate(
      adkEvent({
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'r1', name: 'adk_request_confirmation', args: {} } }],
        },
      }),
    );
    expect(drafts).toEqual([
      { type: 'thread.input_required', requestId: 'r1', kind: 'confirmation' },
      { type: 'thread.status', status: 'awaiting_input' },
    ]);
  });

  it('emits the request before the status, so a client that stops at the status has it', () => {
    // Same ordering rule as thread.error: reason first, then state. A consumer
    // that reacts to `awaiting_input` by rendering an approval control must
    // already know what it is approving.
    const t = new AdkEventTranslator('running');
    const drafts = t.translate(
      adkEvent({
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'r1', name: 'adk_request_confirmation', args: {} } }],
        },
      }),
    );
    const request = drafts.findIndex((d) => d.type === 'thread.input_required');
    const status = drafts.findIndex((d) => d.type === 'thread.status');
    expect(request).toBeGreaterThanOrEqual(0);
    expect(request).toBeLessThan(status);
  });

  it('carries the gated call arguments, which the interrupt itself does not', () => {
    // ADK names the tool and stops there. "Approve requestRefund" is the same
    // sentence for $4 and $400, so the adapter pairs the interrupt with the
    // arguments from the call that triggered it.
    const t = new AdkEventTranslator('running');
    t.translate(
      adkEvent({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'c1',
                name: 'requestRefund',
                args: { orderId: 'A-1001', amount: 129.99 },
              },
            },
          ],
        },
      }),
    );
    const drafts = t.translate(
      adkEvent({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'r1',
                name: 'adk_request_confirmation',
                args: { originalFunctionCall: { name: 'requestRefund' } },
              },
            },
          ],
        },
      }),
    );
    expect(drafts[0]).toMatchObject({
      type: 'thread.input_required',
      requestId: 'r1',
      toolName: 'requestRefund',
      toolArgs: { orderId: 'A-1001', amount: 129.99 },
    });
  });
});

describe('errors and termination', () => {
  it('translates an errorCode event into a terminal error', () => {
    const t = new AdkEventTranslator('streaming');
    const drafts = t.translate(adkEvent({ errorCode: 'RATE_LIMIT', errorMessage: 'slow down' }));

    // Reason before state, so a consumer that stops at the terminal status has
    // already received the explanation.
    expect(drafts).toEqual([
      { type: 'thread.error', message: 'slow down', code: 'RATE_LIMIT' },
      { type: 'thread.status', status: 'error' },
    ]);
    expect(t.currentStatus).toBe('error');
  });

  it('closes an open message when the stream ends mid-flight', () => {
    // Otherwise the UI keeps a streaming caret on a thread that is finished.
    const t = new AdkEventTranslator('running');
    t.translate(text('a', 'half a sen', true));

    const drafts = t.finish('cancelled');
    expect(drafts).toEqual([
      { type: 'message.complete', messageId: 'msg-1', author: 'a', text: 'half a sen' },
      { type: 'thread.status', status: 'cancelled' },
    ]);
  });

  it('drops an illegal status transition rather than throwing', () => {
    // ADK can emit a trailing event after cancellation; losing that race must
    // not take the server down.
    const t = new AdkEventTranslator('running');
    t.finish('cancelled');
    expect(t.translate(text('a', 'late arrival', true))).toEqual([
      { type: 'message.delta', messageId: 'msg-1', author: 'a', delta: 'late arrival' },
    ]);
    expect(t.currentStatus).toBe('cancelled');
  });
});

describe('single ownership of status', () => {
  it('derives the initial running status through begin(), not by publishing directly', () => {
    // Regression: the thread runner used to publish `running` itself. That left
    // the translator on `queued`, so its next transition was computed from the
    // wrong state, dropped as illegal, and the two machines diverged until
    // `assertTransition` threw and failed the whole thread.
    const t = new AdkEventTranslator('queued');
    expect(t.begin()).toEqual([{ type: 'thread.status', status: 'running' }]);
    expect(t.currentStatus).toBe('running');

    // From `running`, a tool call is legal and must be emitted.
    const drafts = t.translate(
      adkEvent({ content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'x', args: {} } }] } }),
    );
    expect(types(drafts)).toEqual(['tool.call', 'thread.status']);
  });

  it('is idempotent, so a second begin() emits nothing', () => {
    const t = new AdkEventTranslator('queued');
    t.begin();
    expect(t.begin()).toEqual([]);
  });
});

