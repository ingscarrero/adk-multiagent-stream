/**
 * One agent message.
 *
 * The author is shown on every message rather than only on the first: in a
 * multi-agent thread the speaker changes mid-conversation, and a reader who
 * cannot tell which agent said what has lost the thing that makes a multi-agent
 * transcript worth reading.
 */

import type { Message } from './reducer.ts';

export function MessageBubble({ message }: { message: Message }) {
  return (
    <article
      className="message"
      data-testid="agent-message"
      data-author={message.author}
      data-streaming={message.streaming}
    >
      <header className="message__author">{message.author}</header>
      <div className="message__text" data-testid="message-text">
        {message.text}
        {/* The caret is a rendering detail, not content: hiding it keeps it out
            of the accessible name and out of test text assertions. */}
        {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
      </div>
    </article>
  );
}
