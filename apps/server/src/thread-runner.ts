/**
 * Thread lifecycle: creation, sequencing, cancellation.
 *
 * A "thread" here is one user prompt and the whole agent run it triggers. The
 * `ThreadRunner` owns the two things the rest of the system trusts:
 *
 * 1. **`seq`** — the per-thread monotonic counter stamped on every event. It is
 *    assigned in exactly one place (`commit`) so it cannot drift, and it is
 *    committed only once the event is stored and on the wire, so it cannot
 *    gap.
 * 2. **The terminal status** — a thread always ends in `complete`, `error`, or
 *    `cancelled`, including when the ADK stream throws, the client aborts, or
 *    the message store refuses a write. The `finally` block is what guarantees
 *    a thread never hangs in `streaming`.
 *
 * Threads are started fire-and-forget: `POST /api/threads` returns as soon as
 * the thread exists, and all subsequent output arrives on the SSE stream. That
 * is what makes concurrent threads possible at all — a blocking create endpoint
 * would serialise them at the HTTP layer.
 *
 * ## What this file still keeps in process
 *
 * The thread registry -- `threads`, `sequences`, and the per-thread chains --
 * is a private map with no provider port behind it. That is the one piece of
 * state a durable message store does *not* recover after a restart: the store
 * can hold every transcript and still have nobody to ask it for them, because
 * `restore` discovers thread ids through this map. L7 in docs/LIMITATIONS.md
 * names that seam; it is deliberately not opened here.
 */

import { randomUUID } from 'node:crypto';
import { Runner, StreamingMode, type BaseSessionService } from '@google/adk';
import { createAgent, type AgentId } from '@feed/agents';
import { memoryMessageStore, memorySessions, type KnowledgeProvider, type MessageStore } from '@feed/providers';
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
 * Settled events a recovery snapshot carries per thread, at most.
 *
 * A thread stores roughly five events per turn, so this is a couple of hundred
 * turns -- far past what a feed card is readable at, and small enough that a
 * session with many long threads cannot turn one snapshot into a multi-megabyte
 * response. A thread over the cap comes back with its *newest* events and
 * `transcriptTruncated` set, so the client says so instead of passing a tail
 * off as the whole.
 */
export const DEFAULT_SNAPSHOT_TRANSCRIPT_LIMIT = 1000;

/** The `code` carried by the `thread.error` a store refusal produces. */
export const STORE_WRITE_FAILED = 'store_write_failed';

/**
 * The message shape ADK accepts, derived from its own signature.
 *
 * It is `Content` from `@google/genai`, but importing that here would add a
 * dependency the server has no other use for -- and pin a second copy of a
 * package whose version must match ADK's. Deriving it means the type follows
 * whatever ADK is compiled against.
 */
type AdkMessage = NonNullable<Parameters<Runner['runAsync']>[0]['newMessage']>;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The message store refused a write.
 *
 * Distinguished from every other failure because it is the one `run` must not
 * report through the path that just failed. Carries the draft so the wind-down
 * can re-send it: the translator already advanced its state machine when it
 * produced this draft, and dropping it would leave the client one transition
 * behind the server for the rest of the thread.
 */
export class StoreWriteError extends Error {
  constructor(
    readonly draft: FeedEventDraft,
    override readonly cause: unknown,
  ) {
    super(`Message store refused ${draft.type}: ${describe(cause)}`);
    this.name = 'StoreWriteError';
  }
}

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
  /**
   * Where the durable transcript lives.
   *
   * Distinct from the event stream, which is a retention window. This is what
   * makes a thread readable after that window has rolled -- see L7.
   */
  messageStore?: MessageStore;
  /** Per-thread cap on the settled events a snapshot carries. See {@link DEFAULT_SNAPSHOT_TRANSCRIPT_LIMIT}. */
  snapshotTranscriptLimit?: number;
}

/**
 * How an emit treats a store refusal.
 *
 * `strict` is the ordinary path: the event is not published unless it is
 * stored, so nothing a client sees is unrecoverable. `tolerant` is the
 * wind-down after the store has already refused a write: the store is still
 * *tried*, so a transient fault leaves no hole it did not have to, but the
 * event reaches the wire either way. A thread that cannot record its own
 * failure must still be able to report it.
 */
type EmitMode = 'strict' | 'tolerant';

export class ThreadRunner {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly sequences = new Map<string, number>();
  /**
   * One promise chain per thread, so emits for a thread run strictly one after
   * another. The atomic commit in {@link commit} depends on it: a seq reserved
   * for one event must be committed or released before the next event reserves
   * one, or two events could both reserve `n + 1`.
   */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly sessionService: BaseSessionService;
  private readonly messageStore: MessageStore;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: ThreadRunnerOptions = {}) {
    this.sessionService = options.sessionService ?? memorySessions().service();
    this.messageStore = options.messageStore ?? memoryMessageStore();
  }

  get(threadId: string): ThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  list(sessionId: string): ThreadRecord[] {
    return [...this.threads.values()].filter((thread) => thread.sessionId === sessionId);
  }

  /**
   * A session's threads *with* their transcripts, for the recovery snapshot.
   *
   * The endpoint used to return identity alone, because there was nothing else
   * to return -- events lived only in the replay window. With a store behind
   * it, recovery hands back the conversation itself. The client applies a
   * transcript directly, bypassing its ordering gates (a transcript has gaps
   * where the deltas were, by design), and only then lets the gated live
   * replay land on top.
   *
   * ## One consistent snapshot, from two sources
   *
   * The registry is read first and the store second, and the order matters.
   * An event is appended to the store *before* its seq and status are committed
   * to the record, so the store can be ahead of the registry and is never
   * behind it (the tolerant wind-down is the exception, and there the record
   * is ahead, which the same rule handles). Any transcript event past the
   * snapshot's `lastSeq` is therefore newer than the snapshot, and the last
   * status among them supersedes the record's. Read the other way round, the
   * snapshot could carry a status the transcript had already moved past;
   * hydration would apply it last, and the live replay of the newer one would
   * then be dropped as redundant -- a thread stuck on a status it left.
   *
   * ## Bounded per thread
   *
   * The store is unbounded, deliberately, but a snapshot is one JSON response
   * and cannot be. Threads over `snapshotTranscriptLimit` carry their newest
   * events and say so. Pagination across snapshots is not offered: the one
   * caller is the recovery path, which needs the recent state of every thread
   * and not the full text of any.
   */
  async restore(sessionId: string): Promise<ThreadSummary[]> {
    const limit = this.options.snapshotTranscriptLimit ?? DEFAULT_SNAPSHOT_TRANSCRIPT_LIMIT;
    const summaries = this.summaries(sessionId);
    const stored = await this.messageStore.transcripts(summaries.map((s) => s.id));

    return summaries.map((summary) => {
      const transcript = stored.get(summary.id) ?? [];
      const newest = transcript.findLast(
        (event): event is Extract<FeedEvent, { type: 'thread.status' }> =>
          event.type === 'thread.status' && event.seq > summary.lastSeq,
      );
      const kept = transcript.length > limit ? transcript.slice(-limit) : transcript;
      return {
        ...summary,
        status: newest?.status ?? summary.status,
        lastSeq: Math.max(summary.lastSeq, transcript.at(-1)?.seq ?? 0),
        transcript: kept,
        ...(kept.length < transcript.length ? { transcriptTruncated: true } : {}),
      };
    });
  }

  /**
   * Identity only, without transcripts: what the registry knows, ordered by
   * creation so the feed rebuilds in the order it was first rendered.
   *
   * `lastSeq` is the committed high-water mark. A client recovering from a
   * replay-buffer overrun needs to know where each thread's sequence has
   * reached, or the next live event looks like an unbridgeable gap.
   */
  summaries(sessionId: string): Omit<ThreadSummary, 'transcript'>[] {
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
    // creation event is the run's own first emit rather than a separate one
    // it is chained onto, so a store that refuses it is handled by the same
    // wind-down as any other refusal instead of leaving the thread `queued`
    // with nothing on the wire.
    this.track(
      this.run(
        thread,
        params.hub,
        { role: 'user', parts: [{ text: thread.prompt }] },
        { type: 'thread.created', prompt: thread.prompt, agent: thread.agent },
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

    this.track(
      this.run(
        thread,
        params.hub,
        { role: 'user', parts: [{ text: params.prompt }] },
        { type: 'message.user', text: params.prompt },
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
   * Stamps, stores, publishes and commits one draft, in that order, and one
   * at a time per thread.
   *
   * Ordering within a thread is fixed by the chain: emits are appended to it
   * in call order and each starts only when the previous has committed or
   * been released. That is what makes the seq reservation in {@link commit}
   * safe, and it cannot depend on how fast the store or the stream accepts a
   * write.
   */
  private emit(
    hub: SessionHub,
    thread: ThreadRecord,
    draft: FeedEventDraft,
    mode: EmitMode,
  ): Promise<FeedEvent> {
    const previous = this.chains.get(thread.id) ?? Promise.resolve();
    const next = previous.then(() => this.commit(hub, thread, draft, mode));
    // A refusal must not poison the chain for the wind-down that follows it.
    this.chains.set(
      thread.id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * The one place `seq` is assigned, and the one place the record moves.
   *
   * The next seq is *reserved* synchronously and *committed* only after the
   * event is stored and published. The counter, the record's status and its
   * pending request all move in that single synchronous step, so no reader of
   * the registry can see a seq without the status that came with it. If the
   * store refuses the write on the strict path, nothing has moved: the seq is
   * released, and the next emit for this thread reuses it. That is the
   * no-gap guarantee -- a client never waits on a seq that was consumed by an
   * event it will not receive. See docs/STREAMING-CONTRACT.md §5c.
   *
   * Store before publish, and await both. The order is the durability
   * guarantee: an event a client has seen must already be recoverable, or a
   * reconnect a millisecond later would find less history than the connection
   * that dropped. The store ignores deltas itself, so this is roughly five
   * writes per turn rather than every one.
   */
  private async commit(
    hub: SessionHub,
    thread: ThreadRecord,
    draft: FeedEventDraft,
    mode: EmitMode,
  ): Promise<FeedEvent> {
    const seq = (this.sequences.get(thread.id) ?? 0) + 1;

    // Validating on the way out means a protocol mistake fails in the server's
    // own tests rather than as a silently-dropped frame in the browser.
    const event = parseFeedEvent({ ...draft, threadId: thread.id, seq, ts: Date.now() });

    try {
      await this.messageStore.append(thread.id, event);
    } catch (cause) {
      if (mode === 'strict') throw new StoreWriteError(draft, cause);
      // Tolerant: the turn is already being wound down because of this store.
      // The write was still attempted, so a fault that has cleared leaves the
      // transcript whole; one that has not leaves a hole the snapshot's status
      // (from the record) covers honestly.
    }

    await hub.publish(event);

    this.sequences.set(thread.id, seq);
    if (event.type === 'thread.status') {
      // The record's status and the translator's are stepped together, so a
      // divergence would be an immediate assertion failure.
      thread.status = assertTransition(thread.status, event.status);
    }
    if (event.type === 'thread.input_required') {
      thread.pendingRequest = {
        requestId: event.requestId,
        ...(event.toolName ? { toolName: event.toolName } : {}),
      };
    }
    return event;
  }

  /**
   * Runs one turn: a fresh ADK invocation against the thread's existing session.
   *
   * Called for the opening prompt, for a follow-up, and to resume after an
   * approval. What differs between the three is `newMessage` and, for the first
   * two, the `opening` event published before the turn begins -- everything
   * about sequencing, status and teardown is shared, which is why this is one
   * method rather than three that would drift.
   *
   * The translator is seeded with the thread's *current* status rather than
   * `queued`, so a second turn transitions from where the first one left off
   * instead of asserting its way out of the status machine.
   *
   * ## When the store refuses a write
   *
   * The turn ends. The refused draft and everything after it go out on the
   * tolerant path -- still offered to the store, published regardless -- the
   * model call is aborted, and the thread is closed with a `thread.error`
   * carrying {@link STORE_WRITE_FAILED} and a terminal `error` status. The
   * record moves with the wire, so a snapshot taken afterwards reports the
   * failure rather than a thread stuck in `queued`. Nothing in the wind-down
   * can hit the store's failure path a second time, which is what makes
   * `finally` safe to run after `catch` has already reported.
   */
  private async run(
    thread: ThreadRecord,
    hub: SessionHub,
    newMessage: AdkMessage,
    opening?: FeedEventDraft,
  ): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(thread.id, controller);

    const translator = new AdkEventTranslator(thread.status);
    let mode: EmitMode = 'strict';
    let storeFailure: StoreWriteError | undefined;

    const publish = async (drafts: FeedEventDraft[]) => {
      // Sequentially: drafts from one translate() call are ordered, and a
      // remote stream must receive them in that order. A batch is resumed
      // from the refused draft rather than abandoned, because the translator
      // has already moved past every draft in it.
      const queue = [...drafts];
      while (queue.length > 0) {
        try {
          await this.emit(hub, thread, queue[0]!, mode);
          queue.shift();
        } catch (error) {
          if (!(error instanceof StoreWriteError)) throw error;
          storeFailure = error;
          mode = 'tolerant';
          // Stop generating what cannot be recorded. Reported below as the
          // store's failure, not as a cancellation.
          controller.abort();
        }
      }
    };

    let outcome: ThreadStatus = 'complete';

    try {
      if (opening) await publish([opening]);
      await publish(translator.begin());

      if (!storeFailure) {
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
          if (storeFailure) break;
        }
      }

      if (storeFailure) outcome = 'error';
      else if (controller.signal.aborted) outcome = 'cancelled';
      else if (translator.currentStatus === 'error') outcome = 'error';
      // A run that paused for a human is not finished, and closing it out as
      // `complete` would both lie and make the thread unanswerable. This is the
      // one path where the turn ends on a non-terminal status.
      else if (translator.currentStatus === 'awaiting_input') outcome = 'awaiting_input';
    } catch (error) {
      if (storeFailure) {
        // The abort above may surface here as ADK's own abort error. The
        // store is why the turn ended, and it is reported in `finally`.
        outcome = 'error';
      } else if (controller.signal.aborted) {
        outcome = 'cancelled';
      } else {
        outcome = 'error';
        // May itself trip the store, in which case `publish` degrades and
        // `finally` reports that too.
        await publish(translator.fail(describe(error)));
      }
    } finally {
      // The guarantee, stated precisely: every turn ends in a terminal status,
      // or in `awaiting_input` with a request the client can answer. Nothing
      // else. Either way any half-written message is closed out, so no caret is
      // left blinking on a thread that has stopped.
      //
      // Idempotent by construction: `fail` and `finish` emit nothing for a
      // status the translator already holds, and by now every emit is
      // tolerant of the store, so this block cannot re-enter the path that
      // brought it here.
      if (storeFailure) {
        await publish(
          translator.fail(
            `The transcript store refused a write, so this turn was stopped: ${describe(storeFailure.cause)}`,
            STORE_WRITE_FAILED,
          ),
        );
      }
      await publish(translator.finish(outcome));
    }
  }
}
