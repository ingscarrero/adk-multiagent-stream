/**
 * ApprovalPrompt tests.
 *
 * The control exists so a person can see *what* they are approving. The
 * assertions therefore centre on the arguments being rendered, and on the two
 * buttons reporting the decision faithfully.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalPrompt, type ApprovalPromptProps } from './ApprovalPrompt.tsx';

const request = (
  overrides: Partial<ApprovalPromptProps['request']> = {},
): ApprovalPromptProps['request'] => ({
  requestId: 'req-1',
  kind: 'confirmation',
  toolName: 'requestRefund',
  toolArgs: { orderId: 'A-1001', amount: 129.99, reason: 'Arrived damaged' },
  ...overrides,
});

describe('ApprovalPrompt', () => {
  it('names the gated tool and lists every argument it would run with', () => {
    render(<ApprovalPrompt request={request()} onDecide={vi.fn()} />);

    expect(screen.getByTestId('approval-prompt')).toHaveTextContent('Approve requestRefund?');
    const args = screen.getByTestId('approval-args');
    expect(args).toHaveTextContent('orderId');
    expect(args).toHaveTextContent('A-1001');
    expect(args).toHaveTextContent('amount');
    expect(args).toHaveTextContent('129.99');
    expect(args).toHaveTextContent('reason');
    expect(args).toHaveTextContent('Arrived damaged');
  });

  it('serialises non-scalar arguments so nothing is hidden', () => {
    render(
      <ApprovalPrompt
        request={request({ toolArgs: { items: ['a', 'b'], flag: true } })}
        onDecide={vi.fn()}
      />,
    );
    const args = screen.getByTestId('approval-args');
    expect(args).toHaveTextContent('["a","b"]');
    expect(args).toHaveTextContent('true');
  });

  it('falls back to a generic title and no argument list when the request carries neither', () => {
    render(
      <ApprovalPrompt
        request={request({ toolName: undefined, toolArgs: undefined })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId('approval-prompt')).toHaveTextContent(
      'This thread needs your approval to continue.',
    );
    expect(screen.queryByTestId('approval-args')).not.toBeInTheDocument();
  });

  it('reports approve as true and deny as false', async () => {
    const onDecide = vi.fn();
    render(<ApprovalPrompt request={request()} onDecide={onDecide} />);

    await userEvent.click(screen.getByTestId('approve'));
    expect(onDecide).toHaveBeenLastCalledWith(true);

    await userEvent.click(screen.getByTestId('deny'));
    expect(onDecide).toHaveBeenLastCalledWith(false);
  });

  it('is an alert: the run has stopped and will not continue until answered', () => {
    render(<ApprovalPrompt request={request()} onDecide={vi.fn()} />);
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('approval-prompt'));
  });
});
