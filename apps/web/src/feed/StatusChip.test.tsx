/**
 * StatusChip tests.
 *
 * The chip is the one visual that every status passes through, so the label
 * table is asserted exhaustively rather than by example: a status added to the
 * protocol without a label would otherwise render as `undefined`.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { THREAD_STATUSES, type ThreadStatus } from '@feed/protocol';
import { StatusChip, statusLabel } from './StatusChip.tsx';

const EXPECTED: Record<ThreadStatus, string> = {
  queued: 'Queued',
  running: 'Thinking',
  streaming: 'Streaming',
  awaiting_tool: 'Using a tool',
  awaiting_input: 'Needs input',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Stopped',
};

describe('statusLabel', () => {
  it.each(THREAD_STATUSES)('has a human label for %s', (status) => {
    expect(statusLabel(status)).toBe(EXPECTED[status]);
  });
});

describe('StatusChip', () => {
  it('renders the label and exposes the raw status for tests and CSS', () => {
    render(<StatusChip status="awaiting_tool" />);
    const chip = screen.getByTestId('status-chip');
    expect(chip).toHaveTextContent('Using a tool');
    expect(chip).toHaveAttribute('data-status', 'awaiting_tool');
    expect(chip).toHaveClass('chip--awaiting_tool');
  });

  it('is hidden from assistive tech, because the thread live region already announces it', () => {
    render(<StatusChip status="streaming" />);
    expect(screen.getByTestId('status-chip')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(['queued', 'running', 'streaming', 'awaiting_tool'] as ThreadStatus[])(
    'shows a motion cue while %s',
    (status) => {
      const { container } = render(<StatusChip status={status} />);
      expect(container.querySelector('.chip__pulse')).not.toBeNull();
    },
  );

  it.each(['awaiting_input', 'complete', 'error', 'cancelled'] as ThreadStatus[])(
    'shows no motion cue while %s -- nothing is happening',
    (status) => {
      const { container } = render(<StatusChip status={status} />);
      expect(container.querySelector('.chip__pulse')).toBeNull();
    },
  );
});
