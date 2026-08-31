/**
 * Thread status: the single source of truth for a thread's lifecycle.
 *
 * Every surface in the system (server, reducer, UI chip, test assertion) reads
 * status from here. The point of centralising it is that an illegal transition
 * becomes a *compile-or-test* failure rather than a UI that silently shows
 * "streaming" forever because one code path forgot to close the thread out.
 *
 * @see docs/STREAMING-CONTRACT.md for the rendered state diagram.
 */

/** Every state a thread can occupy. Ordered roughly by lifecycle position. */
export const THREAD_STATUSES = [
  /** Accepted by the server, not yet picked up by a runner. */
  'queued',
  /** A runner is executing, but no model tokens have arrived yet. */
  'running',
  /** Model tokens are actively arriving. */
  'streaming',
  /** Suspended on a tool call; the agent resumes when the tool returns. */
  'awaiting_tool',
  /** Suspended on a human-in-the-loop request (confirmation, credential, input). */
  'awaiting_input',
  /** Terminal: the agent finished its turn. */
  'complete',
  /** Terminal: the run failed. `Thread.error` carries the reason. */
  'error',
  /** Terminal: the client aborted the run. */
  'cancelled',
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** Statuses from which no further transition is legal. */
export const TERMINAL_STATUSES = ['complete', 'error', 'cancelled'] as const satisfies readonly ThreadStatus[];

export type TerminalThreadStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * The legal transition table.
 *
 * Deliberately exhaustive rather than permissive: a status pair that is not
 * listed here is a bug somewhere upstream, and we would rather find out in a
 * unit test than in a demo.
 */
const TRANSITIONS: Readonly<Record<ThreadStatus, readonly ThreadStatus[]>> = {
  queued: ['running', 'cancelled', 'error'],
  // `running -> complete` is legal: an agent may finish a turn with no text
  // (a pure delegation, or a tool-only turn).
  running: ['streaming', 'awaiting_tool', 'awaiting_input', 'complete', 'cancelled', 'error'],
  // `streaming -> running` is legal and common: one agent's message finishes
  // and the next agent in a pipeline starts before producing any text.
  streaming: ['running', 'awaiting_tool', 'awaiting_input', 'complete', 'cancelled', 'error'],
  // After a tool returns, the agent goes back to the model, which may stream
  // again or immediately call another tool.
  awaiting_tool: ['running', 'streaming', 'awaiting_tool', 'complete', 'cancelled', 'error'],
  awaiting_input: ['running', 'streaming', 'cancelled', 'error'],
  complete: [],
  error: [],
  cancelled: [],
};

/** Whether `to` is a legal successor of `from`. */
export function canTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Whether a status admits no successor. */
export function isTerminal(status: ThreadStatus): status is TerminalThreadStatus {
  return (TERMINAL_STATUSES as readonly ThreadStatus[]).includes(status);
}

/**
 * Applies a transition, or throws.
 *
 * Used on the server, where an illegal transition means the ADK event adapter
 * has mis-classified an event and we want a loud failure. The client reducer
 * uses {@link canTransition} directly and ignores illegal transitions instead,
 * because a client must tolerate a replayed or out-of-order event.
 */
export function assertTransition(from: ThreadStatus, to: ThreadStatus): ThreadStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal thread status transition: ${from} -> ${to}`);
  }
  return to;
}

/** Whether the thread is doing work the user should see a spinner for. */
export function isActive(status: ThreadStatus): boolean {
  return !isTerminal(status);
}
