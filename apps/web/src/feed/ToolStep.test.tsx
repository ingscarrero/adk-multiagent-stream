/**
 * ToolStep tests.
 *
 * A tool call renders collapsed with its arguments always available and its
 * result only once it exists. The pending/done distinction is what the feed
 * uses to show `awaiting_tool` at the level of the individual call.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolStep } from './ToolStep.tsx';
import type { ToolInvocation } from './reducer.ts';

const pending: ToolInvocation = {
  callId: 'c1',
  name: 'lookupOrder',
  args: { orderId: 'A-1001' },
  state: 'pending',
};

const done: ToolInvocation = {
  ...pending,
  state: 'done',
  result: { found: true, status: 'shipped' },
};

describe('ToolStep', () => {
  it('renders collapsed, with the tool name and its state exposed', () => {
    const { container } = render(<ToolStep tool={pending} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByTestId('tool-step')).toHaveAttribute('data-tool', 'lookupOrder');
    expect(screen.getByTestId('tool-step')).toHaveAttribute('data-state', 'pending');
  });

  it('shows the arguments as pretty-printed JSON before the tool returns', () => {
    render(<ToolStep tool={pending} />);
    expect(screen.getByText('Arguments')).toBeInTheDocument();
    expect(screen.getByText(/"orderId": "A-1001"/)).toBeInTheDocument();
    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('marks a pending call as running and a finished one as done', () => {
    const { rerender } = render(<ToolStep tool={pending} />);
    expect(screen.getByText('running…')).toBeInTheDocument();

    rerender(<ToolStep tool={done} />);
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByTestId('tool-step')).toHaveAttribute('data-state', 'done');
  });

  it('shows the result once the tool has returned', () => {
    render(<ToolStep tool={done} />);
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.getByText(/"status": "shipped"/)).toBeInTheDocument();
  });
});
