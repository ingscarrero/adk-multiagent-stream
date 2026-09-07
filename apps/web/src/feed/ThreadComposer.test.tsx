/**
 * ThreadComposer tests.
 *
 * Same keyboard contract as the main composer -- Enter sends, Shift+Enter
 * breaks the line -- pinned here so the two cannot drift apart unnoticed.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadComposer } from './ThreadComposer.tsx';

describe('ThreadComposer', () => {
  it('disables Send while the input is blank, including whitespace', async () => {
    render(<ThreadComposer onSend={vi.fn()} />);
    const send = screen.getByTestId('follow-up-send');
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByTestId('follow-up-input'), '   ');
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByTestId('follow-up-input'), 'when will it arrive?');
    expect(send).toBeEnabled();
  });

  it('sends the trimmed text on click and clears the input', async () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);

    await userEvent.type(screen.getByTestId('follow-up-input'), '  when will it arrive?  ');
    await userEvent.click(screen.getByTestId('follow-up-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('when will it arrive?');
    expect(screen.getByTestId('follow-up-input')).toHaveValue('');
  });

  it('sends on Enter', async () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);

    await userEvent.type(screen.getByTestId('follow-up-input'), 'any update?{Enter}');
    expect(onSend).toHaveBeenCalledWith('any update?');
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);

    await userEvent.type(screen.getByTestId('follow-up-input'), 'line one{Shift>}{Enter}{/Shift}line two');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('follow-up-input')).toHaveValue('line one\nline two');
  });

  it('ignores Enter on an empty input rather than sending a blank follow-up', async () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);

    await userEvent.type(screen.getByTestId('follow-up-input'), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('has an accessible name that says which thread it belongs to', () => {
    render(<ThreadComposer onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: /follow-up in this thread/i })).toBeInTheDocument();
  });
});
