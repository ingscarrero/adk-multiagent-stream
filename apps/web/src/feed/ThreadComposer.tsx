/**
 * The per-thread composer, shown once a turn has finished.
 *
 * Separate from the main composer rather than a reused one, because the two
 * answer different questions: the main composer starts a conversation and picks
 * an agent, this one continues a conversation that already has one. Merging them
 * would mean an agent selector that has to be hidden half the time.
 *
 * It renders only while the thread can accept a follow-up, which is what keeps
 * the control honest -- there is no disabled state to explain, because a thread
 * that cannot take a message does not offer a box to type one in.
 */

import { useState, type FormEvent, type KeyboardEvent } from 'react';

export interface ThreadComposerProps {
  onSend: (prompt: string) => void;
}

export function ThreadComposer({ onSend }: ThreadComposerProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const prompt = value.trim();
    if (!prompt) return;
    onSend(prompt);
    // Cleared immediately rather than on acknowledgement: the send is a POST
    // whose only job is to be accepted, and leaving the text sitting there
    // invites a double send.
    setValue('');
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  // Enter sends, Shift+Enter breaks the line -- the same contract as the main
  // composer, because a user should not have to learn two.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="threadComposer" onSubmit={onSubmit} data-testid="thread-composer">
      <textarea
        className="threadComposer__input"
        data-testid="follow-up-input"
        rows={1}
        value={value}
        placeholder="Ask a follow-up…"
        aria-label="Ask a follow-up in this thread"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="button button--ghost"
        data-testid="follow-up-send"
        disabled={value.trim().length === 0}
      >
        Send
      </button>
    </form>
  );
}
