/**
 * The human-in-the-loop gate.
 *
 * Rendered while a thread sits in `awaiting_input`. The thread is not working
 * and not finished -- it is waiting on a person -- which is why this is a
 * decision control rather than a spinner.
 *
 * ## What it shows, and why that is the whole point
 *
 * ADK's own confirmation prompt names the tool and nothing else ("approve or
 * reject the tool call requestRefund()"). That is not enough to decide with: a
 * $4 refund and a $400 refund are the same sentence. So the server carries the
 * arguments the call would run with, and this renders them. Approving an action
 * you cannot see the parameters of is a rubber stamp, not a control.
 */

import type { ThreadState } from './reducer.ts';

export interface ApprovalPromptProps {
  request: NonNullable<ThreadState['inputRequest']>;
  onDecide: (approved: boolean) => void;
}

/** Renders one argument value compactly; objects fall back to JSON. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function ApprovalPrompt({ request, onDecide }: ApprovalPromptProps) {
  const args = Object.entries(request.toolArgs ?? {});

  return (
    <div
      className="approval"
      data-testid="approval-prompt"
      // The one place in a thread where an assertive announcement is right: the
      // run has stopped and will not continue until this is answered, which is
      // exactly the situation `alert` exists for. Streaming prose stays quiet
      // for the opposite reason.
      role="alert"
    >
      <p className="approval__title">
        {request.toolName ? (
          <>
            Approve <code>{request.toolName}</code>?
          </>
        ) : (
          'This thread needs your approval to continue.'
        )}
      </p>

      {args.length > 0 ? (
        <dl className="approval__args" data-testid="approval-args">
          {args.map(([key, value]) => (
            <div className="approval__arg" key={key}>
              <dt>{key}</dt>
              <dd>{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="approval__actions">
        <button
          type="button"
          className="button button--primary"
          data-testid="approve"
          onClick={() => onDecide(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="button button--ghost"
          data-testid="deny"
          onClick={() => onDecide(false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
