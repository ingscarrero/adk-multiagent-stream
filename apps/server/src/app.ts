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
import { createThreadRequestSchema } from '@feed/protocol';
import { loadConfig, type ServerConfig } from './config.ts';
import { HubRegistry } from './sse.ts';
import { ThreadRunner, type ThreadRunnerOptions } from './thread-runner.ts';

export interface AppDeps {
  config?: ServerConfig;
  runnerOptions?: ThreadRunnerOptions;
}

export interface FeedApp {
  app: Express;
  config: ServerConfig;
  hubs: HubRegistry;
  threads: ThreadRunner;
  /** Releases timers and open connections. Always call this in tests. */
  close: () => Promise<void>;
}

export function createApp(deps: AppDeps = {}): FeedApp {
  const config = deps.config ?? loadConfig();
  const hubs = new HubRegistry({
    heartbeatMs: config.heartbeatMs,
    replayBufferSize: config.replayBufferSize,
    reconnectDelayMs: config.reconnectDelayMs,
  });
  const threads = new ThreadRunner(deps.runnerOptions);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(cors({ origin: config.corsOrigins, credentials: false }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      modelMode: config.modelMode,
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
  app.post('/api/threads', (req: Request, res: Response) => {
    const sessionId = readSessionId(req);
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

  // Typing the params generically keeps `threadId` a string; Express 5 widens
  // untyped `req.params` values to `string | string[]` for wildcard routes.
  /**
   * A session's threads, without transcripts.
   *
   * The recovery path for a replay-buffer overrun: when the stream tells a
   * client its resume point is gone, this is what it rebuilds from. Cheap and
   * idempotent, so a client may call it whenever it suspects it has drifted.
   */
  app.get('/api/threads', (req: Request, res: Response) => {
    const sessionId = readSessionId(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    res.json({ threads: threads.summaries(sessionId) });
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
  app.get('/api/stream', (req: Request, res: Response) => {
    const sessionId = readSessionId(req);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    // `Last-Event-ID` is set by the browser automatically on reconnect; the
    // query param is the manual escape hatch used by tests and by clients that
    // resume after a full page reload.
    const lastEventId =
      req.get('Last-Event-ID') ?? (typeof req.query['lastEventId'] === 'string' ? req.query['lastEventId'] : undefined);

    const detach = hubs.get(sessionId).subscribe(res, lastEventId);
    // `close` fires for a client navigating away, a network drop, and an
    // aborted fetch alike — it is the only teardown hook that catches all three.
    req.on('close', detach);
  });

  return {
    app,
    config,
    hubs,
    threads,
    close: async () => {
      hubs.closeAll();
      await threads.drain();
    },
  };
}

/** Session id from header or query. Header is preferred; query keeps EventSource simple. */
function readSessionId(req: Request): string | undefined {
  const fromHeader = req.get('x-session-id');
  if (fromHeader) return fromHeader;
  const fromQuery = req.query['sessionId'];
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : undefined;
}
