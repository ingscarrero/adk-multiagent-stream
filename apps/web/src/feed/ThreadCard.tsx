/**
 * One thread: the user's prompt, the agent's work, and a status.
 *
 * ## Accessibility
 *
 * Each thread is its own `aria-live="polite"` region rather than one live
 * region for the whole feed. With several threads streaming at once a single
 * region would announce a jumble of interleaved text; per-thread regions let a
 * screen reader queue each thread's updates coherently.
 *
 * The live region wraps the *status line*, not the streaming text. Marking
 * streaming prose as live makes assistive tech re-announce a message on every
 * token, which is unusable. The reader is told the thread changed state and can
 * navigate to the content when they want it.
 */

import { canAcceptFollowUp, isTerminal } from '@feed/protocol';
import { MessageBubble } from './MessageBubble.tsx';
import { StatusChip, statusLabel } from './StatusChip.tsx';
import { ToolStep } from './ToolStep.tsx';
import { ThreadComposer } from './ThreadComposer.tsx';
import { ApprovalPrompt } from './ApprovalPrompt.tsx';
import type { ThreadState } from './reducer.ts';

export interface ThreadCardProps {
  thread: ThreadState;
  onCancel: (threadId: string) => void;
  onFollowUp: (threadId: string, prompt: string) => void;
  onRespond: (threadId: string, requestId: string, approved: boolean) => void;
}

export function ThreadCard({ thread, onCancel, onFollowUp, onRespond }: ThreadCardProps) {
  const active = !isTerminal(thread.status);
  /**
   * Rebuilt from a snapshot with nothing recoverable.
   *
   * After a replay-buffer overrun the server can restore a thread's identity
   * and status but not its transcript, so a whole session's worth of finished
   * threads can come back empty. Those render as a quiet one-line row rather
   * than a card with a warning bar &mdash; they are history, not a problem to
   * act on.
   */
  const nothingSurvived = thread.historyTruncated && thread.timeline.length === 0;

  return (
    <section
      className="thread"
      data-testid="thread"
      data-thread-id={thread.id}
      data-status={thread.status}
      aria-label={`Thread: ${thread.prompt}`}
    >
      <header className="thread__header">
        <div className="thread__prompt">
          <p className="thread__promptText" data-testid="thread-prompt">
            {thread.prompt}
          </p>
          <p className="thread__agent" data-testid="thread-agent">
            {thread.agent}
          </p>
        </div>

        <div className="thread__controls">
          <StatusChip status={thread.status} />
          {active ? (
            <button
              type="button"
              className="button button--ghost"
              data-testid="cancel-thread"
              onClick={() => onCancel(thread.id)}
            >
              Stop
            </button>
          ) : null}
        </div>
      </header>

      {/* Status is announced here; see the module docstring for why the
          streaming text itself is not a live region. */}
      <p className="sr-only" aria-live="polite" data-testid="thread-status-announcement">
        {`${thread.prompt}: ${statusLabel(thread.status)}`}
      </p>

      <div className="thread__body">
        {/* A thread rebuilt from a snapshot has lost part or all of its
            transcript. Saying so is the whole point of recovering it &mdash; a
            silently empty thread is what the resync was meant to prevent.

            The two cases read very differently to a person, so they say
            different things. "Earlier messages were lost" on a thread with no
            messages at all is misleading: nothing was earlier, the whole
            transcript is gone. */}
        {thread.historyTruncated ? (
          <p
            className={`thread__truncated ${nothingSurvived ? 'thread__truncated--total' : ''}`}
            data-testid="thread-truncated"
            data-extent={nothingSurvived ? 'total' : 'partial'}
          >
            {nothingSurvived
              ? 'Messages for this thread are no longer available.'
              : 'Earlier messages in this thread were lost while reconnecting.'}
          </p>
        ) : null}

        {thread.timeline.length === 0 && active ? (
          <p className="thread__placeholder" data-testid="thread-placeholder">
            Waiting for the agent…
          </p>
        ) : null}

        {thread.timeline.map((item, index) => {
          if (item.kind === 'message') {
            const message = thread.messages[item.id];
            return message ? <MessageBubble key={item.id} message={message} /> : null;
          }
          if (item.kind === 'user') {
            return (
              // Index in the key because a follow-up carries no id: it is never
              // updated after arrival, so its position is a stable identity.
              <p className="thread__userMessage" key={`user-${index}`} data-testid="user-message">
                {item.text}
              </p>
            );
          }
          const tool = thread.tools[item.callId];
          return tool ? <ToolStep key={item.callId} tool={tool} /> : null;
        })}

        {thread.error ? (
          <p className="thread__error" role="alert" data-testid="thread-error">
            {thread.error.message}
            {thread.error.code ? <code className="thread__errorCode">{thread.error.code}</code> : null}
          </p>
        ) : null}

        {thread.inputRequest ? (
          <ApprovalPrompt
            request={thread.inputRequest}
            onDecide={(approved) => onRespond(thread.id, thread.inputRequest!.requestId, approved)}
          />
        ) : null}

        {canAcceptFollowUp(thread.status) ? (
          <ThreadComposer onSend={(prompt) => onFollowUp(thread.id, prompt)} />
        ) : null}
      </div>
    </section>
  );
}
