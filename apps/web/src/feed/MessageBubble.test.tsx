/**
 * MessageBubble tests.
 *
 * Small on purpose. The two things worth pinning are the author attribution
 * (the reason a multi-agent transcript is readable at all) and the caret being
 * a rendering detail rather than content.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble.tsx';
import type { Message } from './reducer.ts';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  author: 'order_agent',
  text: 'Order A-1001 has shipped.',
  streaming: false,
  ...overrides,
});

describe('MessageBubble', () => {
  it('names the author on every message', () => {
    render(<MessageBubble message={message({ author: 'kb_agent' })} />);
    const article = screen.getByTestId('agent-message');
    expect(article).toHaveAttribute('data-author', 'kb_agent');
    expect(article.querySelector('.message__author')).toHaveTextContent('kb_agent');
  });

  it('renders the text verbatim', () => {
    render(<MessageBubble message={message()} />);
    expect(screen.getByTestId('message-text')).toHaveTextContent('Order A-1001 has shipped.');
  });

  it('shows a caret only while streaming, and keeps it out of the accessible text', () => {
    const { container, rerender } = render(<MessageBubble message={message({ streaming: true })} />);
    const caret = container.querySelector('.caret');
    expect(caret).not.toBeNull();
    expect(caret).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('agent-message')).toHaveAttribute('data-streaming', 'true');

    rerender(<MessageBubble message={message({ streaming: false })} />);
    expect(container.querySelector('.caret')).toBeNull();
    expect(screen.getByTestId('agent-message')).toHaveAttribute('data-streaming', 'false');
  });
});
