/**
 * The state machine is small enough to test exhaustively, so we do: every one
 * of the 64 (status, status) pairs is asserted against an independent table.
 * A transition added to `status.ts` without a deliberate decision here fails.
 */
import { describe, expect, it } from 'vitest';
import {
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
  awaiting_tool: ['running', 'streaming', 'awaiting_tool', 'complete', 'cancelled', 'error'],
  awaiting_input: ['running', 'streaming', 'cancelled', 'error'],
  complete: [],
  error: [],
  cancelled: [],
};

describe('canTransition', () => {
  it.each(THREAD_STATUSES)('is exhaustively correct from %s', (from) => {
    for (const to of THREAD_STATUSES) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(EXPECTED[from].includes(to));
    }
  });

  it('never allows a transition out of a terminal status', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of THREAD_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
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
