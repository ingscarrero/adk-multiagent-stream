/**
 * The prompt input.
 *
 * Two conversational-UX decisions worth naming:
 *
 * - **The composer never blocks.** Submitting does not disable the input or
 *   wait for a response, because the whole premise is that you can start a
 *   second thread while the first is still streaming.
 * - **Enter sends, Shift+Enter newlines.** The convention every chat product
 *   has converged on; violating it is a papercut users notice immediately.
 */

import { useState, type FormEvent, type KeyboardEvent } from 'react';

export interface ComposerProps {
  agents: Array<{ id: string; label: string; description: string }>;
  onSubmit: (prompt: string, agent: string) => void;
  disabled?: boolean;
}

/**
 * Suggestions belong to an agent, and only that agent's are offered.
 *
 * An earlier version let each suggestion carry its own agent and fire
 * regardless of the dropdown. That ran every demo on the right agent, but it
 * made the dropdown look broken: the chips are the obvious way in, and none of
 * them respected it. Selecting an agent now changes the suggestions, the
 * description, and what Send uses - one control, three visible effects.
 */
const SUGGESTIONS: Record<string, string[]> = {
  router: [
    'Where is my order, can you track shipping?',
    'What is your warranty coverage?',
  ],
  research: [
    'How should we position the product?',
    'What should we emphasise about delivery?',
  ],
};

export function Composer({ agents, onSubmit, disabled = false }: ComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState(agents[0]?.id ?? 'router');
  const selected = agents.find((option) => option.id === agent);

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onSubmit(trimmed, agent);
    // Clear immediately: the thread appears in the feed, so leaving the text in
    // place would read as "that didn't send".
    setPrompt('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit} data-testid="composer">
      <div className="composer__row">
        <label className="sr-only" htmlFor="composer-agent">
          Agent
        </label>
        <select
          id="composer-agent"
          className="composer__select"
          data-testid="agent-select"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          {agents.map((option) => (
            <option key={option.id} value={option.id} title={option.description}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="composer-prompt">
          Message
        </label>
        <textarea
          id="composer-prompt"
          className="composer__input"
          data-testid="prompt-input"
          rows={1}
          placeholder="Ask something. Enter to send, Shift+Enter for a new line."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
        />

        <button
          type="submit"
          className="button button--primary"
          data-testid="send-button"
          disabled={disabled || prompt.trim().length === 0}
        >
          Send
        </button>
      </div>

      {selected ? (
        <p className="composer__hint" data-testid="agent-description">
          {selected.description}
        </p>
      ) : null}

      <ul className="composer__suggestions">
        {(SUGGESTIONS[agent] ?? []).map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              className="chipButton"
              data-testid="suggestion"
              data-agent={agent}
              onClick={() => onSubmit(suggestion, agent)}
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
    </form>
  );
}
