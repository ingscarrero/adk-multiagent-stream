/**
 * Composer tests.
 *
 * These exist because of a specific regression: the agent dropdown was wired to
 * Send but not to the suggestion chips, and since the chips are the obvious way
 * to interact, the dropdown looked broken to anyone who never typed a prompt.
 * A control with no visible effect is a bug even when the code behind it works.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer.tsx';

const AGENTS = [
  { id: 'router', label: 'Support router', description: 'Delegates to a specialist.' },
  { id: 'research', label: 'Research pipeline', description: 'Parallel research, then synthesis.' },
];

const renderComposer = (onSubmit = vi.fn()) => {
  render(<Composer agents={AGENTS} onSubmit={onSubmit} />);
  return onSubmit;
};

describe('the agent select has visible effects', () => {
  it('shows the selected agent description', async () => {
    renderComposer();
    expect(screen.getByTestId('agent-description')).toHaveTextContent('Delegates to a specialist.');

    await userEvent.selectOptions(screen.getByTestId('agent-select'), 'research');
    expect(screen.getByTestId('agent-description')).toHaveTextContent('Parallel research');
  });

  it('changes which suggestions are offered', async () => {
    renderComposer();
    expect(screen.getAllByTestId('suggestion').map((b) => b.textContent)).toEqual([
      'Where is my order, can you track shipping?',
      'What is your warranty coverage?',
      'Refund order A-1001, it arrived damaged',
    ]);

    await userEvent.selectOptions(screen.getByTestId('agent-select'), 'research');
    const research = screen.getAllByTestId('suggestion').map((b) => b.textContent);
    expect(research).toContain('How should we position the product?');
    expect(research).not.toContain('What is your warranty coverage?');
  });

  it('sends a suggestion with the selected agent, not a hardcoded one', async () => {
    // The regression. Chips used to carry their own agent and ignore the select.
    const onSubmit = renderComposer();
    await userEvent.selectOptions(screen.getByTestId('agent-select'), 'research');
    await userEvent.click(screen.getAllByTestId('suggestion')[0]!);

    expect(onSubmit).toHaveBeenCalledWith('How should we position the product?', 'research');
  });

  it('sends a typed prompt with the selected agent', async () => {
    const onSubmit = renderComposer();
    await userEvent.selectOptions(screen.getByTestId('agent-select'), 'research');
    await userEvent.type(screen.getByTestId('prompt-input'), 'custom question');
    await userEvent.click(screen.getByTestId('send-button'));

    expect(onSubmit).toHaveBeenCalledWith('custom question', 'research');
  });
});

describe('send affordance', () => {
  it('is disabled only while the prompt is empty', async () => {
    renderComposer();
    const send = screen.getByTestId('send-button');
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByTestId('prompt-input'), 'hello');
    expect(send).toBeEnabled();
  });

  it('stays enabled for typing while a thread is running', async () => {
    // The composer never blocks: starting a second thread mid-stream is the
    // entire premise of the feed.
    renderComposer();
    await userEvent.type(screen.getByTestId('prompt-input'), 'hello');
    expect(screen.getByTestId('prompt-input')).toBeEnabled();
    expect(screen.getByTestId('send-button')).toBeEnabled();
  });

  it('clears the input after sending', async () => {
    renderComposer();
    await userEvent.type(screen.getByTestId('prompt-input'), 'hello');
    await userEvent.click(screen.getByTestId('send-button'));
    expect(screen.getByTestId('prompt-input')).toHaveValue('');
  });
});
