/**
 * Translates ADK `Event`s into wire `FeedEvent`s.
 *
 * This is the only file in the repo that understands both vocabularies, and it
 * is deliberately the only one. Everything downstream — the reducer, the React
 * components, every Playwright assertion — is written against `FeedEvent`, so
 * swapping ADK for another framework is a rewrite of this file and nothing else.
 *
 * ## What makes this non-trivial
 *
 * ADK emits a flat stream of events for an entire agent *tree*. With a
 * `ParallelAgent`, two sub-agents emit interleaved partial text on the same
 * invocation. Naively concatenating text as it arrives produces one message
 * with two agents' words shuffled together.
 *
 * The fix is to key in-flight messages by `author`, so each agent accumulates
 * into its own message with its own `messageId`. That is why `openMessages` is
 * a Map rather than a single field, and it is asserted in `adk-adapter.test.ts`.
 *
 * The translator assigns no `seq` and no `ts` — those belong to the thread that
 * owns ordering. It emits *drafts*, and `ThreadRunner` stamps them.
 */

import { getUserInputRequests, type Event } from '@google/adk';
import {
  canTransition,
  type FeedEvent,
  type ThreadStatus,
} from '@feed/protocol';

/** A FeedEvent minus the fields the owning thread stamps on. */
export type FeedEventDraft = FeedEvent extends infer T
  ? T extends { threadId: string; seq: number; ts: number }
    ? Omit<T, 'threadId' | 'seq' | 'ts'>
    : never
  : never;

/**
 * ADK's framework-internal function calls.
 *
 * These are control-plane, not user-facing tools. `transfer_to_agent` is
 * surfaced (a handoff is meaningful to the reader), while the `adk_request_*`
 * family moves the thread into `awaiting_input` instead of rendering as a tool.
 */
const HUMAN_INPUT_CALLS = new Set([
  'adk_request_confirmation',
  'adk_request_credential',
  'adk_request_input',
]);

export const TRANSFER_CALL = 'transfer_to_agent';

let messageCounter = 0;
const nextMessageId = () => `msg-${(messageCounter += 1)}`;

/** Resets the module-level message id counter. Test-only. */
export function resetMessageIds(): void {
  messageCounter = 0;
}

export class AdkEventTranslator {
  /** In-flight messages, keyed by author. See the class docstring. */
  private readonly openMessages = new Map<string, { messageId: string; text: string }>();
  /**
   * Arguments of tool calls seen but not yet resolved, keyed by tool name.
   *
   * Exists for one reason: a confirmation request names the tool it is gating
   * but not the arguments it would run with, and "approve requestRefund" is a
   * materially worse question to put to a person than "approve a $129.99 refund
   * on order A-1001". ADK emits the call and the interrupt as two consecutive
   * events, so the args are always already here when the request arrives.
   */
  private readonly pendingToolArgs = new Map<string, Record<string, unknown>>();

  private status: ThreadStatus;

  constructor(initialStatus: ThreadStatus = 'queued') {
    this.status = initialStatus;
  }

  get currentStatus(): ThreadStatus {
    return this.status;
  }

  /**
   * Produces a status draft if the transition is both a change and legal.
   *
   * Illegal transitions are dropped rather than thrown: ADK can emit a trailing
   * event after a run is already cancelled, and losing the race should not take
   * the server down. `assertTransition` is used at the thread level, where the
   * transitions are ours rather than the framework's.
   */
  private setStatus(next: ThreadStatus): FeedEventDraft[] {
    if (next === this.status || !canTransition(this.status, next)) return [];
    this.status = next;
    return [{ type: 'thread.status', status: next }];
  }

  /**
   * Marks the run as started.
   *
   * The only status not derived from an ADK event, and it still goes through
   * the translator rather than being published directly. Publishing it directly
   * desyncs the translator's state machine from the thread's, after which every
   * subsequent transition is computed from the wrong `from` state.
   */
  begin(): FeedEventDraft[] {
    return this.setStatus('running');
  }

  /** Translates one ADK event into zero or more feed drafts, in emit order. */
  translate(event: Event): FeedEventDraft[] {
    const drafts: FeedEventDraft[] = [];
    const author = event.author ?? 'agent';

    // A model-layer failure is terminal. Emit the error and stop translating.
    //
    // The error is emitted BEFORE the terminal status, deliberately: a consumer
    // that stops reading once a thread reaches a terminal state must already
    // have the reason in hand. Reason first, then state.
    if (event.errorCode || event.errorMessage) {
      drafts.push({
        type: 'thread.error',
        message: event.errorMessage ?? 'The agent run failed.',
        ...(event.errorCode ? { code: event.errorCode } : {}),
      });
      drafts.push(...this.setStatus('error'));
      return drafts;
    }

    const parts = event.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? '').join('');
    const functionCalls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
    const functionResponses = parts.flatMap((part) =>
      part.functionResponse ? [part.functionResponse] : [],
    );

    // --- Tool results come first: they close out an awaiting_tool state. ---
    for (const response of functionResponses) {
      this.pendingToolArgs.delete(response.name ?? '');
      drafts.push({
        type: 'tool.result',
        callId: response.id ?? `${author}:${response.name ?? 'unknown'}`,
        name: response.name ?? 'unknown',
        result: response.response ?? null,
      });
    }
    if (functionResponses.length > 0) {
      drafts.push(...this.setStatus('running'));
    }

    // --- Text ---
    if (text.length > 0) {
      if (event.partial) {
        let open = this.openMessages.get(author);
        if (!open) {
          open = { messageId: nextMessageId(), text: '' };
          this.openMessages.set(author, open);
        }
        open.text += text;
        drafts.push(...this.setStatus('streaming'));
        drafts.push({ type: 'message.delta', messageId: open.messageId, author, delta: text });
      } else {
        // A final (non-partial) event carries the whole message. Reuse the open
        // message id when there is one so the client replaces rather than
        // appends; mint a fresh one for a non-streamed message.
        const open = this.openMessages.get(author);
        const messageId = open?.messageId ?? nextMessageId();
        this.openMessages.delete(author);
        // No status change here. If the message streamed, we are already in
        // `streaming`; if it arrived whole (a non-streamed turn), the thread was
        // never streaming and claiming otherwise would be a lie the UI renders.
        drafts.push({ type: 'message.complete', messageId, author, text });
      }
    }

    // --- Tool and framework calls ---
    const humanInput = functionCalls.filter((call) => HUMAN_INPUT_CALLS.has(call.name ?? ''));
    const toolCalls = functionCalls.filter((call) => !HUMAN_INPUT_CALLS.has(call.name ?? ''));

    for (const call of toolCalls) {
      drafts.push({
        type: 'tool.call',
        callId: call.id ?? `${author}:${call.name ?? 'unknown'}`,
        name: call.name ?? 'unknown',
        args: call.args ?? {},
      });
      this.pendingToolArgs.set(call.name ?? 'unknown', call.args ?? {});
    }
    if (toolCalls.length > 0) {
      drafts.push(...this.setStatus('awaiting_tool'));
    }

    // A pause is not visible in an event's text -- it is a functionCall part
    // named `adk_request_*`, with everything useful buried in its args. ADK
    // ships `getUserInputRequests` to flatten the three encodings into one
    // shape, so this does not have to know how each kind stores its id.
    if (humanInput.length > 0) {
      for (const request of getUserInputRequests(event)) {
        const args = request.toolName ? this.pendingToolArgs.get(request.toolName) : undefined;
        drafts.push({
          type: 'thread.input_required',
          requestId: request.interruptId,
          kind: request.kind,
          ...(request.toolName ? { toolName: request.toolName } : {}),
          ...(args ? { toolArgs: args } : {}),
          ...(request.message ? { prompt: request.message } : {}),
        });
      }
      // Status last, so a client that stops at the status already has the
      // request in hand -- the same reason `thread.error` precedes its status.
      drafts.push(...this.setStatus('awaiting_input'));
    }

    return drafts;
  }

  /**
   * Closes the turn out. Called by `ThreadRunner` when the ADK stream ends.
   *
   * `final` is usually terminal, and is `awaiting_input` when the run paused on
   * a human decision -- the one case where a turn ends without the thread
   * ending. Setting the same status twice is a no-op, so passing
   * `awaiting_input` when the translator is already there emits nothing.
   */
  finish(final: ThreadStatus): FeedEventDraft[] {
    const drafts: FeedEventDraft[] = [];

    // Flush any message left open by a stream that ended mid-flight, so the UI
    // never keeps a caret blinking on a thread that is done.
    for (const [author, open] of this.openMessages) {
      drafts.push({
        type: 'message.complete',
        messageId: open.messageId,
        author,
        text: open.text,
      });
    }
    this.openMessages.clear();

    drafts.push(...this.setStatus(final));
    return drafts;
  }

  /** Produces a terminal error draft pair for a failure outside the ADK stream. */
  fail(message: string, code?: string): FeedEventDraft[] {
    // Reason before state — see `translate`.
    return [
      { type: 'thread.error', message, ...(code ? { code } : {}) },
      ...this.setStatus('error'),
    ];
  }
}
