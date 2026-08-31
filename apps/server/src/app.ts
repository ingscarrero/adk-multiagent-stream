/**
 * The HTTP surface. Four routes, deliberately.
 *
 *   POST /api/threads            start a thread; returns immediately
 *   GET  /api/stream             the multiplexed SSE feed for a session
 *   POST /api/threads/:id/cancel abort a run in flight
 *   GET  /api/health             liveness + which model mode is active
 *
 * The app is built by a factory rather than instantiated at module scope so
 * tests can construct one per case with their own config and no open ports.
 */

import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import { AGENT_CATALOG, DEFAULT_AGENT_ID, isAgentId } from '@feed/agents';
import {
  createThreadRequestSchema,
  followUpRequestSchema,
  inputResponseRequestSchema,
} from '@feed/protocol';
import { describeCapabilities, resolveProviders, type Providers } from '@feed/providers';
import { loadConfig, type ServerConfig } from './config.ts';
import { HubRegistry } from './sse.ts';
import { ThreadRunner, type ThreadRunnerOptions } from './thread-runner.ts';

export interface AppDeps {
  config?: ServerConfig;
  runnerOptions?: ThreadRunnerOptions;
  /** Overridable so tests can inject fakes without touching the environment. */
  providers?: Providers;
}

export interface FeedApp {
  app: Express;
  config: ServerConfig;
  hubs: HubRegistry;
  threads: ThreadRunner;
  providers: Providers;
  /** Releases timers and open connections. Always call this in tests. */
  close: () => Promise<void>;
}

export function createApp(deps: AppDeps = {}): FeedApp {
  const config = deps.config ?? loadConfig();
  const providers = deps.providers ?? resolveProviders(config.providers);
  // Retention lives on the stream provider now, not on the hub: it is a
  // property of the log, and the real adapter needs it just as much.
  const hubs = new HubRegistry(providers.eventStream, {
    heartbeatMs: config.heartbeatMs,
    reconnectDelayMs: config.reconnectDelayMs,
    maxBufferedBytes: config.maxBufferedBytes,
    idleTtlMs: config.idleTtlMs,
    sweepIntervalMs: config.sweepIntervalMs,
  });
  const threads = new ThreadRunner({
    ...deps.runnerOptions,
    sessionService: providers.sessions.service(),
    knowledge: providers.knowledge,
    messageStore: providers.messageStore,
  });

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(cors({ origin: config.corsOrigins, credentials: false }));

  /**
   * Liveness, and the emulated-versus-real matrix.
   *
   * The matrix is served rather than only documented so the boundary can be
   * checked at runtime instead of trusted. docs/PROVIDERS.md explains each row.
   */
  /**
   * The caller's feed, via the identity provider.
   *
   * Under the emulated adapter this trusts a header or query parameter; under
   * `PROVIDER_IDENTITY=jwt` it verifies a token. The routes below do not know
   * which, which is the point of the port.
   */
  const sessionIdOf = async (req: Request): Promise<string | undefined> =>
    (await providers.identity.resolve(req))?.sessionId;

  app.get('/api/health', (_req: Request, res: Response) => {
    const capabilities = describeCapabilities({
      model: config.modelMode,
      sessions: providers.sessions.mode,
      knowledge: providers.knowledge.mode,
      identity: providers.identity.mode,
      eventStream: providers.eventStream.mode,
      messageStore: providers.messageStore.mode,
    });

    res.json({
      status: 'ok',
      modelMode: config.modelMode,
      capabilities,
      emulated: capabilities.filter((c) => c.emulated).map((c) => c.capability),
      agents: Object.entries(AGENT_CATALOG).map(([id, meta]) => ({ id, ...meta })),
    });
  });

  /**
   * Starts a thread.
   *
   * Returns 202 rather than 200: the work has been accepted, not completed.
   * The response body carries only the ids the client needs to correlate the
   * thread with the events already arriving on its open stream.
   */
  app.post('/api/threads', async (req: Request, res: Response) => {
    const sessionId = await sessionIdOf(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const parsed = createThreadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const agent = parsed.data.agent ?? DEFAULT_AGENT_ID;
    if (!isAgentId(agent)) {
      res.status(400).json({ error: `Unknown agent "${agent}"` });
      return;
    }

    const thread = threads.start({
      sessionId,
      agent,
      prompt: parsed.data.prompt,
      hub: hubs.get(sessionId),
    });

    res.status(202).json({ threadId: thread.id, sessionId });
  });

  /**
   * A follow-up in an existing thread.
   *
   * Same shape as `POST /api/threads`: accept or reject, and let the run's
   * output arrive on the stream. `409` rather than `400` when the thread cannot
   * take one, because the request is well-formed and the *state* is what
   * refuses it -- a distinction worth keeping when a client is deciding whether
   * to retry.
   */
  app.post('/api/threads/:threadId/messages', async (req: Request<{ threadId: string }>, res: Response) => {
    const sessionId = await sessionIdOf(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const parsed = followUpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const existing = threads.get(req.params.threadId);
    // The session check is authorisation, thin as it is: a thread belongs to the
    // session that created it, and answering "not found" for someone else's
    // thread leaks less than "forbidden". See L9 for what real identity needs.
    if (!existing || existing.sessionId !== sessionId) {
      res.status(404).json({ error: 'No such thread' });
      return;
    }

    const thread = threads.followUp({
      threadId: existing.id,
      prompt: parsed.data.prompt,
      hub: hubs.get(sessionId),
    });
    if (!thread) {
      res.status(409).json({ error: `Thread is ${existing.status} and cannot take a follow-up` });
      return;
    }

    res.status(202).json({ threadId: thread.id, sessionId });
  });

  /**
   * Answers the human-input request a paused thread is blocked on.
   *
   * Four outcomes rather than two, because "no" has three different meanings
   * here and a client that cannot tell them apart cannot behave sensibly:
   * the thread is gone, the thread is not waiting, or it is waiting on a
   * *different* request than the one being answered.
   */
  app.post('/api/threads/:threadId/respond', async (req: Request<{ threadId: string }>, res: Response) => {
    const sessionId = await sessionIdOf(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const parsed = inputResponseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const existing = threads.get(req.params.threadId);
    if (!existing || existing.sessionId !== sessionId) {
      res.status(404).json({ error: 'No such thread' });
      return;
    }

    const outcome = threads.respond({
      threadId: existing.id,
      requestId: parsed.data.requestId,
      approved: parsed.data.approved,
      hub: hubs.get(sessionId),
    });

    if (outcome === 'accepted') {
      res.status(202).json({ threadId: existing.id, approved: parsed.data.approved });
      return;
    }
    if (outcome === 'wrong-request') {
      // Deliberately not "close enough": approving a request that is no longer
      // the pending one is how a stale click authorises something nobody read.
      res.status(409).json({ error: 'That request is no longer the one awaiting an answer' });
      return;
    }
    res.status(409).json({ error: `Thread is ${existing.status} and is not awaiting input` });
  });

  // Typing the params generically keeps `threadId` a string; Express 5 widens
  // untyped `req.params` values to `string | string[]` for wildcard routes.
  /**
   * A session's threads, without transcripts.
   *
   * The recovery path for a replay-buffer overrun: when the stream tells a
   * client its resume point is gone, this is what it rebuilds from. Cheap and
   * idempotent, so a client may call it whenever it suspects it has drifted.
   */
  app.get('/api/threads', async (req: Request, res: Response) => {
    const sessionId = await sessionIdOf(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    res.json({ threads: await threads.restore(sessionId) });
  });

  app.post('/api/threads/:threadId/cancel', (req: Request<{ threadId: string }>, res: Response) => {
    const { threadId } = req.params;
    const thread = threads.get(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Unknown thread' });
      return;
    }
    const cancelled = threads.cancel(threadId);
    res.status(cancelled ? 202 : 409).json({ threadId, cancelled });
  });

  /**
   * The feed.
   *
   * One long-lived response per browser session. The client never polls; every
   * update for every thread arrives here.
   */
  app.get('/api/stream', async (req: Request, res: Response) => {
    const sessionId = await sessionIdOf(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    // `Last-Event-ID` is set by the browser automatically on reconnect; the
    // query param is the manual escape hatch used by tests and by clients that
    // resume after a full page reload.
    const lastEventId =
      req.get('Last-Event-ID') ?? (typeof req.query['lastEventId'] === 'string' ? req.query['lastEventId'] : undefined);

    const detach = await hubs.get(sessionId).subscribe(res, lastEventId);
    // `close` fires for a client navigating away, a network drop, and an
    // aborted fetch alike — it is the only teardown hook that catches all three.
    req.on('close', detach);
  });

  return {
    app,
    config,
    hubs,
    threads,
    providers,
    close: async () => {
      hubs.closeAll();
      await threads.drain();
      await providers.close();
    },
  };
}


