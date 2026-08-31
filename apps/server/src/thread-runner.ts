/**
 * Thread lifecycle: creation, sequencing, cancellation.
 *
 * A "thread" here is one user prompt and the whole agent run it triggers. The
 * `ThreadRunner` owns the two things the rest of the system trusts:
 *
 * 1. **`seq`** — the per-thread monotonic counter stamped on every event. It is
 *    assigned in exactly one place (`emit`) so it cannot drift.
 * 2. **The terminal status** — a thread always ends in `complete`, `error`, or
 *    `cancelled`, including when the ADK stream throws or the client aborts.
 *    The `finally` block is what guarantees a thread never hangs in `streaming`.
 *
 * Threads are started fire-and-forget: `POST /api/threads` returns as soon as
 * the thread exists, and all subsequent output arrives on the SSE stream. That
 * is what makes concurrent threads possible at all — a blocking create endpoint
 * would serialise them at the HTTP layer.
 */

import { randomUUID } from 'node:crypto';
import { Runner, StreamingMode, type BaseSessionService } from '@google/adk';
import { createAgent, type AgentId } from '@feed/agents';
import { memorySessions, type KnowledgeProvider } from '@feed/providers';
import {
  assertTransition,
  canAcceptFollowUp,
  parseFeedEvent,
  type FeedEvent,
  type ThreadStatus,
  type ThreadSummary,
} from '@feed/protocol';
import { AdkEventTranslator, type FeedEventDraft } from './adk-adapter.ts';
import type { SessionHub } from './sse.ts';

const APP_NAME = 'adk-agent-feed';

/**
 * The message shape ADK accepts, derived from its own signature.
 *
 * It is `Content` from `@google/genai`, but importing that here would add a
 * dependency the server has no other use for -- and pin a second copy of a
 * package whose version must match ADK's. Deriving it means the type follows
 * whatever ADK is compiled against.
 */
type AdkMessage = NonNullable<Parameters<Runner['runAsync']>[0]['newMessage']>;

export interface ThreadRecord {
  id: string;
  sessionId: string;
  agent: AgentId;
  /** The opening prompt. Follow-ups do not replace it -- it names the thread. */
  prompt: string;
  status: ThreadStatus;
  createdAt: number;
  /**
   * The outstanding human-input request, when the thread is paused on one.
   *
   * Held here rather than only on the wire because the answer arrives on a
   * *different* HTTP request, which has to be able to check that the id being
   * answered is the id actually pending. Cleared when the run resumes.
   */
  pendingRequest?: { requestId: string; toolName?: string };
}

export interface ThreadRunnerOptions {
  /** Injected so tests can run with zero chunk delay. */
  chunkDelayMs?: number;
  /** Guards against a runaway agent loop burning the whole budget. */
  maxLlmCalls?: number;
  /**
   * Where conversation state lives.
   *
   * Supplied by the session provider rather than constructed here, so swapping
   * in ADK's `DatabaseSessionService` is a config change and not an edit to
   * this file. Defaults to in-memory for tests that do not care.
   */
  sessionService?: BaseSessionService;
  /**
   * Retrieval backing the knowledge tool.
   *
   * Threaded through to `createAgent` so a swap of `PROVIDER_KNOWLEDGE` reaches
   * the agents without this file knowing which adapter it is.
   */
  knowledge?: KnowledgeProvider;
}

export class ThreadRunner {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly sequences = new Map<string, number>();
  private readonly sessionService: BaseSessionService;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: ThreadRunnerOptions = {}) {
    this.sessionService = options.sessionService ?? memorySessions().service();
  }

  get(threadId: string): ThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  list(sessionId: string): ThreadRecord[] {
    return [...this.threads.values()].filter((thread) => thread.sessionId === sessionId);
  }

  /**
   * A session's threads as summaries, for `GET /api/threads`.
   *
   * `lastSeq` is the point of the whole endpoint: a client recovering from a
   * replay-buffer overrun needs to know where each thread's sequence has
   * reached, or the next live event looks like an unbridgeable gap and the
   * thread stalls forever. Ordered by creation so the feed rebuilds in the same
   * order it was originally rendered.
   */
  summaries(sessionId: string): ThreadSummary[] {
    return this.list(sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((thread) => ({
        id: thread.id,
        prompt: thread.prompt,
        agent: thread.agent,
        status: thread.status,
        createdAt: thread.createdAt,
        lastSeq: this.sequences.get(thread.id) ?? 0,
      }));
  }

  /**
   * Creates a thread, publishes `thread.created`, and starts the agent run.
   *
   * Returns synchronously once the thread is registered. The run itself is a
   * detached promise tracked in `inFlight` purely so tests (and shutdown) can
   * await quiescence.
   */
  start(params: {
    sessionId: string;
    agent: AgentId;
    prompt: string;
    hub: SessionHub;
  }): ThreadRecord {
    const thread: ThreadRecord = {
      id: `thr-${randomUUID()}`,
      sessionId: params.sessionId,
      agent: params.agent,
      prompt: params.prompt,
      status: 'queued',
      createdAt: Date.now(),
    };

    this.threads.set(thread.id, thread);
    this.sequences.set(thread.id, 0);

    // seq 1 for every thread, always, and always before anything else. The
    // run is chained onto it rather than started alongside, so the creation
    // event cannot race the first event the agent produces.
    const opened = this.emit(params.hub, thread.id, {
      type: 'thread.created',
      prompt: thread.prompt,
      agent: thread.agent,
    });

    this.track(
      opened.then(() =>
        this.run(thread, params.hub, { role: 'user', parts: [{ text: thread.prompt }] }),
      ),
      thread.id,
    );

    return thread;
  }

  /**
   * Continues an existing thread with a follow-up message.
   *
   * The whole feature is one line of ADK: run again against the same
   * `sessionId`. ADK accumulates the conversation there, so the agent sees the
   * earlier turns without anything being re-sent. What this method adds is the
   * bookkeeping around that -- re-entering the status machine, and emitting the
   * user's message so it lands in the transcript in the right place.
   */
  followUp(params: { threadId: string; prompt: string; hub: SessionHub }): ThreadRecord | undefined {
    const thread = this.threads.get(params.threadId);
    if (!thread || !canAcceptFollowUp(thread.status)) return undefined;

    const opened = this.emit(params.hub, thread.id, {
      type: 'message.user',
      text: params.prompt,
    });

    this.track(
      opened.then(() =>
        this.run(thread, params.hub, {
          role: 'user',
          parts: [{ text: params.prompt }],
        }),
      ),
      thread.id,
    );
    return thread;
  }

  /**
   * Answers the human-input request a paused thread is blocked on.
   *
   * The reply is a `functionResponse` quoting ADK's interrupt id, which ADK's
   * `RequestConfirmationLlmRequestProcessor` finds in session history and uses
   * to re-invoke the gated tool -- with the decision, so a denial is delivered
   * to the tool as a refusal rather than silently dropping the call.
   *
   * `requestId` must match what is actually pending. A stale approval answering
   * whatever happens to be waiting is the failure this guard exists to prevent;
   * ADK makes the same check on its side and fails closed.
   */
  respond(params: {
    threadId: string;
    requestId: string;
    approved: boolean;
    hub: SessionHub;
  }): 'accepted' | 'not-pending' | 'wrong-request' | 'unknown-thread' {
    const thread = this.threads.get(params.threadId);
    if (!thread) return 'unknown-thread';
    if (thread.status !== 'awaiting_input' || !thread.pendingRequest) return 'not-pending';
    if (thread.pendingRequest.requestId !== params.requestId) return 'wrong-request';

    const { requestId } = thread.pendingRequest;
    delete thread.pendingRequest;

    this.track(
      this.run(thread, params.hub, {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: requestId,
              name: 'adk_request_confirmation',
              // ADK's ToolConfirmation shape. `confirmed: false` is a decision,
              // not an absence of one -- the tool is told it was refused.
              response: { confirmed: params.approved },
            },
          },
        ],
      }),
      thread.id,
    );
    return 'accepted';
  }

  /** Registers a detached run so `drain` can await it. */
  private track(run: Promise<void>, threadId: string): void {
    const tracked = run.finally(() => {
      this.inFlight.delete(tracked);
      this.aborts.delete(threadId);
    });
    this.inFlight.add(tracked);
  }

  /** Requests cancellation. Idempotent, and a no-op on an already-finished thread. */
  cancel(threadId: string): boolean {
    const controller = this.aborts.get(threadId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /** Resolves when every in-flight run has settled. Test and shutdown helper. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Stamps a draft with threadId/seq/ts, validates it, and publishes it.
   *
   * `seq` is assigned synchronously, before the await, so ordering is fixed
   * here and cannot depend on how fast the event stream accepts a write. The
   * append is awaited because a remote stream must land entries in order.
   */
  private async emit(
    hub: SessionHub,
    threadId: string,
    draft: FeedEventDraft,
  ): Promise<FeedEvent> {
    const seq = (this.sequences.get(threadId) ?? 0) + 1;
    this.sequences.set(threadId, seq);

    // Validating on the way out means a protocol mistake fails in the server's
    // own tests rather than as a silently-dropped frame in the browser.
    const event = parseFeedEvent({ ...draft, threadId, seq, ts: Date.now() });
    await hub.publish(event);
    return event;
  }

  /**
   * Runs one turn: a fresh ADK invocation against the thread's existing session.
   *
   * Called for the opening prompt, for a follow-up, and to resume after an
   * approval. The only thing that differs between the three is `newMessage` --
   * everything about sequencing, status and teardown is shared, which is why
   * this is one method rather than three that would drift.
   *
   * The translator is seeded with the thread's *current* status rather than
   * `queued`, so a second turn transitions from where the first one left off
   * instead of asserting its way out of the status machine.
   */
  private async run(
    thread: ThreadRecord,
    hub: SessionHub,
    newMessage: AdkMessage,
  ): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(thread.id, controller);

    const translator = new AdkEventTranslator(thread.status);
    const publish = async (drafts: FeedEventDraft[]) => {
      // Sequentially: drafts from one translate() call are ordered, and a
      // remote stream must receive them in that order.
      for (const draft of drafts) {
        const event = await this.emit(hub, thread.id, draft);
        if (event.type === 'thread.status') {
          // The record's status and the translator's are stepped together, so
          // a divergence would be an immediate assertion failure.
          thread.status = assertTransition(thread.status, event.status);
        }
        if (event.type === 'thread.input_required') {
          thread.pendingRequest = {
            requestId: event.requestId,
            ...(event.toolName ? { toolName: event.toolName } : {}),
          };
        }
      }
    };

    let outcome: ThreadStatus = 'complete';

    try {
      await publish(translator.begin());

      const runner = new Runner({
        appName: APP_NAME,
        // A fresh tree per thread: ADK agents hold a parent back-reference, so
        // sharing one instance across concurrent threads corrupts transfer
        // routing. Construction is cheap; correctness is not.
        agent: createAgent(thread.agent, {
          ...(this.options.chunkDelayMs !== undefined
            ? { chunkDelayMs: this.options.chunkDelayMs }
            : {}),
          ...(this.options.knowledge ? { knowledge: this.options.knowledge } : {}),
        }),
        sessionService: this.sessionService,
      });

      // One ADK session per thread: threads are independent conversations, and
      // sharing a session would leak one thread's history into another's context.
      await this.sessionService.getOrCreateSession({
        appName: APP_NAME,
        userId: thread.sessionId,
        sessionId: thread.id,
      });

      for await (const event of runner.runAsync({
        userId: thread.sessionId,
        sessionId: thread.id,
        newMessage,
        runConfig: {
          streamingMode: StreamingMode.SSE,
          maxLlmCalls: this.options.maxLlmCalls ?? 20,
        },
        abortSignal: controller.signal,
      })) {
        await publish(translator.translate(event));
      }

      if (controller.signal.aborted) outcome = 'cancelled';
      else if (translator.currentStatus === 'error') outcome = 'error';
      // A run that paused for a human is not finished, and closing it out as
      // `complete` would both lie and make the thread unanswerable. This is the
      // one path where the turn ends on a non-terminal status.
      else if (translator.currentStatus === 'awaiting_input') outcome = 'awaiting_input';
    } catch (error) {
      if (controller.signal.aborted) {
        outcome = 'cancelled';
      } else {
        outcome = 'error';
        await publish(translator.fail(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      // The guarantee, stated precisely: every turn ends in a terminal status,
      // or in `awaiting_input` with a request the client can answer. Nothing
      // else. Either way any half-written message is closed out, so no caret is
      // left blinking on a thread that has stopped.
      await publish(translator.finish(outcome));
    }
  }
}
