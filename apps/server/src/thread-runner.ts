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
  parseFeedEvent,
  type FeedEvent,
  type ThreadStatus,
  type ThreadSummary,
} from '@feed/protocol';
import { AdkEventTranslator, type FeedEventDraft } from './adk-adapter.ts';
import type { SessionHub } from './sse.ts';

const APP_NAME = 'adk-agent-feed';

export interface ThreadRecord {
  id: string;
  sessionId: string;
  agent: AgentId;
  prompt: string;
  status: ThreadStatus;
  createdAt: number;
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

    const run = opened
      .then(() => this.run(thread, params.hub))
      .finally(() => {
        this.inFlight.delete(run);
        this.aborts.delete(thread.id);
      });
    this.inFlight.add(run);

    return thread;
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

  private async run(thread: ThreadRecord, hub: SessionHub): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(thread.id, controller);

    const translator = new AdkEventTranslator('queued');
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
        newMessage: { role: 'user', parts: [{ text: thread.prompt }] },
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
    } catch (error) {
      if (controller.signal.aborted) {
        outcome = 'cancelled';
      } else {
        outcome = 'error';
        await publish(translator.fail(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      // The guarantee: whatever happened above, the thread reaches a terminal
      // status and any half-written message is closed out.
      await publish(translator.finish(outcome));
    }
  }
}
