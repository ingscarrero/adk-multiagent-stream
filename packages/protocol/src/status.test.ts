/**
 * The state machine is small enough to test exhaustively, so we do: every one
 * of the 64 (status, status) pairs is asserted against an independent table.
 * A transition added to `status.ts` without a deliberate decision here fails.
 */
import { describe, expect, it } from 'vitest';
import {
  canAcceptFollowUp,
  THREAD_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isActive,
  isTerminal,
  type ThreadStatus,
} from './status.ts';

/** Independent restatement of the legal set — intentionally NOT imported. */
const EXPECTED: Record<ThreadStatus, ThreadStatus[]> = {
  queued: ['running', 'cancelled', 'error'],
  running: ['streaming', 'awaiting_tool', 'awaiting_input', 'complete', 'cancelled', 'error'],
  streaming: ['running', 'awaiting_tool', 'awaiting_input', 'complete', 'cancelled', 'error'],
  awaiting_tool: [
    'running',
    'streaming',
    'awaiting_tool',
    // The confirmation gate: ADK emits the tool call, then the interrupt.
    'awaiting_input',
    'complete',
    'cancelled',
    'error',
  ],
  awaiting_input: ['running', 'streaming', 'cancelled', 'error'],
  // A finished turn re-opens for a follow-up. `error` does not.
  complete: ['running'],
  error: [],
  cancelled: ['running'],
};

describe('canTransition', () => {
  it.each(THREAD_STATUSES)('is exhaustively correct from %s', (from) => {
    for (const to of THREAD_STATUSES) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(EXPECTED[from].includes(to));
    }
  });

  it('lets a terminal status re-open only into running, and only for a follow-up', () => {
    // The weakest form of the old assertion that is still true, and the reason
    // it had to weaken: `complete` ends a *turn*, not a conversation. What must
    // not happen is a terminal status reaching any *other* state -- a finished
    // thread must never appear to be streaming or awaiting a tool.
    for (const from of TERMINAL_STATUSES) {
      for (const to of THREAD_STATUSES) {
        const legal = to === 'running' && canAcceptFollowUp(from);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(legal);
      }
    }
  });

  it('never re-opens an errored thread', () => {
    // A failed run left an unknown amount of work half applied. Continuing on
    // top of it is a worse experience than starting again, so this is a
    // deliberate asymmetry rather than an oversight.
    for (const to of THREAD_STATUSES) {
      expect(canTransition('error', to), `error -> ${to}`).toBe(false);
    }
    expect(canAcceptFollowUp('error')).toBe(false);
  });

  it('agrees with canAcceptFollowUp about which statuses re-open', () => {
    for (const status of THREAD_STATUSES) {
      expect(canTransition(status, 'running') && isTerminal(status)).toBe(
        canAcceptFollowUp(status),
      );
    }
  });

  it('never allows a self-transition except awaiting_tool', () => {
    // A second tool call in the same turn legitimately re-enters awaiting_tool.
    for (const status of THREAD_STATUSES) {
      expect(canTransition(status, status)).toBe(status === 'awaiting_tool');
    }
  });

  it('lets every non-terminal status reach error and cancelled', () => {
    for (const status of THREAD_STATUSES.filter((s) => !isTerminal(s))) {
      expect(canTransition(status, 'error'), `${status} -> error`).toBe(true);
      expect(canTransition(status, 'cancelled'), `${status} -> cancelled`).toBe(true);
    }
  });
});

describe('assertTransition', () => {
  it('returns the target status when legal', () => {
    expect(assertTransition('queued', 'running')).toBe('running');
  });

  it('throws with both statuses named when illegal', () => {
    expect(() => assertTransition('complete', 'streaming')).toThrowError(
      /complete -> streaming/,
    );
  });
});

describe('isTerminal / isActive', () => {
  it('partitions the status space exactly', () => {
    for (const status of THREAD_STATUSES) {
      expect(isActive(status)).toBe(!isTerminal(status));
    }
  });

  it('classifies the three terminal states', () => {
    expect(THREAD_STATUSES.filter(isTerminal)).toEqual(['complete', 'error', 'cancelled']);
  });
});
