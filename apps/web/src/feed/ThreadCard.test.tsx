/**
 * Component tests for the thread card.
 *
 * Scope is deliberately narrow: rendering rules that are cheaper to pin down
 * here than in Playwright — what shows when, and the accessibility affordances
 * that are easy to delete by accident. Behaviour that involves the network or
 * real timing is tested in `e2e/` instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ThreadStatus } from '@feed/protocol';
import { ThreadCard } from './ThreadCard.tsx';
import type { ThreadState } from './reducer.ts';

function thread(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    id: 'thr-1',
    prompt: 'where is my order?',
    agent: 'router',
    status: 'streaming',
    timeline: [],
    messages: {},
    tools: {},
    createdAt: 0,
    updatedAt: 0,
    lastSeq: 1,
    buffered: [],
    historyTruncated: false,
    awaitingResume: false,
    ...overrides,
  };
}

const withMessage = (text: string, streaming: boolean, author = 'order_agent') =>
  thread({
    timeline: [{ kind: 'message', id: 'm1' }],
    messages: { m1: { id: 'm1', author, text, streaming } },
  });

describe('rendering', () => {
  it('shows the prompt, the agent, and the status', () => {
    render(<ThreadCard thread={thread({ status: 'awaiting_tool' })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);

    expect(screen.getByTestId('thread-prompt')).toHaveTextContent('where is my order?');
    expect(screen.getByTestId('thread-agent')).toHaveTextContent('router');
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-status', 'awaiting_tool');
  });

  it('names the message author, so a multi-agent transcript stays readable', () => {
    render(<ThreadCard thread={withMessage('Order A-1001 shipped', false)} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.getByTestId('agent-message')).toHaveAttribute('data-author', 'order_agent');
  });

  it('marks a streaming message so the caret can render', () => {
    render(<ThreadCard thread={withMessage('Order A-10', true)} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.getByTestId('agent-message')).toHaveAttribute('data-streaming', 'true');
  });

  it('shows a placeholder while an active thread has produced nothing', () => {
    render(<ThreadCard thread={thread({ status: 'running' })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.getByTestId('thread-placeholder')).toBeInTheDocument();
  });

  it('hides the placeholder once a thread is terminal and empty', () => {
    render(<ThreadCard thread={thread({ status: 'cancelled' })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.queryByTestId('thread-placeholder')).not.toBeInTheDocument();
  });

  it('renders tools and messages in timeline order', () => {
    const state = thread({
      timeline: [
        { kind: 'tool', callId: 'c1' },
        { kind: 'message', id: 'm1' },
      ],
      tools: { c1: { callId: 'c1', name: 'lookupOrder', args: { orderId: 'A-1' }, state: 'done', result: {} } },
      messages: { m1: { id: 'm1', author: 'order_agent', text: 'Found it', streaming: false } },
    });
    render(<ThreadCard thread={state} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);

    const rendered = screen.getAllByTestId(/tool-step|agent-message/);
    expect(rendered.map((el) => el.dataset['testid'] ?? el.getAttribute('data-testid'))).toEqual([
      'tool-step',
      'agent-message',
    ]);
  });

  it('surfaces an error as an alert', () => {
    render(
      <ThreadCard
        thread={thread({ status: 'error', error: { message: 'model exploded', code: 'BOOM' } })}
        onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('model exploded');
  });
});

describe('cancellation control', () => {
  it.each(['queued', 'running', 'streaming', 'awaiting_tool'] as ThreadStatus[])(
    'offers Stop while the thread is %s',
    (status) => {
      render(<ThreadCard thread={thread({ status })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
      expect(screen.getByTestId('cancel-thread')).toBeInTheDocument();
    },
  );

  it.each(['complete', 'error', 'cancelled'] as ThreadStatus[])(
    'hides Stop once the thread is %s',
    (status) => {
      render(<ThreadCard thread={thread({ status })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
      expect(screen.queryByTestId('cancel-thread')).not.toBeInTheDocument();
    },
  );

  it('passes the thread id to onCancel', async () => {
    const onCancel = vi.fn();
    render(<ThreadCard thread={thread()} onCancel={onCancel} onFollowUp={vi.fn()} onRespond={vi.fn()} />);

    await userEvent.click(screen.getByTestId('cancel-thread'));
    expect(onCancel).toHaveBeenCalledWith('thr-1');
  });
});

describe('accessibility', () => {
  it('gives the thread an accessible name derived from the prompt', () => {
    render(<ThreadCard thread={thread()} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.getByRole('region', { name: /where is my order/i })).toBeInTheDocument();
  });

  it('announces status changes in a polite live region', () => {
    const { rerender } = render(<ThreadCard thread={thread({ status: 'running' })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    const announcement = screen.getByTestId('thread-status-announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveTextContent('Thinking');

    rerender(<ThreadCard thread={thread({ status: 'complete' })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(announcement).toHaveTextContent('Done');
  });

  it('keeps the streaming caret out of the accessible text', () => {
    // A live-updating caret inside announced text makes a screen reader
    // re-read the message on every token.
    render(<ThreadCard thread={withMessage('Half a sen', true)} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.getByTestId('message-text')).toHaveTextContent('Half a sen');
  });
});

describe('threads rebuilt after a replay-buffer overrun', () => {
  it('says the whole transcript is gone when nothing survived', () => {
    // A resync can restore a thread's identity and status but not its content.
    // "Earlier messages were lost" would be misleading here: nothing was
    // earlier, the entire transcript is unavailable.
    render(
      <ThreadCard
        thread={thread({ status: 'complete', historyTruncated: true, timeline: [] })}
        onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()}
      />,
    );
    const notice = screen.getByTestId('thread-truncated');
    expect(notice).toHaveAttribute('data-extent', 'total');
    expect(notice).toHaveTextContent('no longer available');
  });

  it('says earlier messages were lost when some survived', () => {
    render(
      <ThreadCard
        thread={{
          ...thread({ status: 'complete', historyTruncated: true }),
          timeline: [{ kind: 'message', id: 'm1' }],
          messages: { m1: { id: 'm1', author: 'order_agent', text: 'partial', streaming: false } },
        }}
        onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()}
      />,
    );
    const notice = screen.getByTestId('thread-truncated');
    expect(notice).toHaveAttribute('data-extent', 'partial');
    expect(notice).toHaveTextContent('Earlier messages');
  });

  it('shows no notice on a thread that lost nothing', () => {
    render(<ThreadCard thread={thread({ status: 'complete' })} onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()} />);
    expect(screen.queryByTestId('thread-truncated')).not.toBeInTheDocument();
  });

  it('does not show the waiting placeholder on a restored terminal thread', () => {
    // It is finished, not pending; a spinner would be a lie.
    render(
      <ThreadCard
        thread={thread({ status: 'complete', historyTruncated: true, timeline: [] })}
        onCancel={vi.fn()} onFollowUp={vi.fn()} onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('thread-placeholder')).not.toBeInTheDocument();
  });
});

