/**
 * Schema tests guard the wire format itself. They exist so that a field
 * rename in `events.ts` breaks here rather than silently in the browser.
 */
import { describe, expect, it } from 'vitest';
import {
  createThreadRequestSchema,
  parseFeedEvent,
  safeParseFeedEvent,
  type FeedEvent,
} from './events.ts';

const base = { threadId: 't1', seq: 1, ts: 1_700_000_000_000 };

describe('feedEventSchema', () => {
  it('accepts one well-formed event of every kind', () => {
    const events: FeedEvent[] = [
      { type: 'thread.created', ...base, prompt: 'hi', agent: 'router' },
      { type: 'message.delta', ...base, messageId: 'm1', author: 'router', delta: 'He' },
      { type: 'message.complete', ...base, messageId: 'm1', author: 'router', text: 'Hello' },
      { type: 'tool.call', ...base, callId: 'c1', name: 'lookupOrder', args: { id: '42' } },
      { type: 'tool.result', ...base, callId: 'c1', name: 'lookupOrder', result: { ok: true } },
      { type: 'thread.status', ...base, status: 'streaming' },
      { type: 'thread.error', ...base, message: 'boom', code: 'RATE_LIMIT' },
    ];
    for (const event of events) {
      expect(parseFeedEvent(event)).toEqual(event);
    }
  });

  it('rejects seq 0 — sequence numbers start at 1 so gaps are detectable', () => {
    expect(() => parseFeedEvent({ ...base, seq: 0, type: 'thread.status', status: 'queued' })).toThrow();
  });

  it('rejects an unknown event type rather than passing it through', () => {
    expect(safeParseFeedEvent({ ...base, type: 'message.telepathy' })).toBeNull();
  });

  it('returns null instead of throwing on the client parse path', () => {
    // One malformed frame must never tear down a live EventSource.
    expect(safeParseFeedEvent('not json at all')).toBeNull();
    expect(safeParseFeedEvent(null)).toBeNull();
  });

  it('keeps an empty delta legal — models do emit empty chunks', () => {
    expect(
      safeParseFeedEvent({ type: 'message.delta', ...base, messageId: 'm1', author: 'a', delta: '' }),
    ).not.toBeNull();
  });
});

describe('createThreadRequestSchema', () => {
  it('requires a non-empty prompt', () => {
    expect(createThreadRequestSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(createThreadRequestSchema.safeParse({ prompt: 'hello' }).success).toBe(true);
  });

  it('caps prompt length so one request cannot blow the context window', () => {
    expect(createThreadRequestSchema.safeParse({ prompt: 'x'.repeat(4001) }).success).toBe(false);
  });
});
