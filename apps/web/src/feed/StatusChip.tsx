/**
 * The per-thread status indicator.
 *
 * Status is announced to screen readers as well as shown: a sighted user sees
 * a thread go from "Thinking" to "Streaming" to "Done", and a screen-reader
 * user gets the same information from the thread's `aria-live` region rather
 * than from a colour change they cannot perceive.
 */

import type { ThreadStatus } from '@feed/protocol';

const LABELS: Record<ThreadStatus, string> = {
  queued: 'Queued',
  running: 'Thinking',
  streaming: 'Streaming',
  awaiting_tool: 'Using a tool',
  awaiting_input: 'Needs input',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Stopped',
};

/** Statuses that should render a motion cue. */
const BUSY: ReadonlySet<ThreadStatus> = new Set([
  'queued',
  'running',
  'streaming',
  'awaiting_tool',
]);

export function statusLabel(status: ThreadStatus): string {
  return LABELS[status];
}

export function StatusChip({ status }: { status: ThreadStatus }) {
  return (
    <span
      className={`chip chip--${status}`}
      data-testid="status-chip"
      data-status={status}
      // The chip is decorative for assistive tech: the thread's live region
      // already announces the same transition, and duplicating it here would
      // make every status change speak twice.
      aria-hidden="true"
    >
      {BUSY.has(status) ? <span className="chip__pulse" /> : null}
      {LABELS[status]}
    </span>
  );
}
