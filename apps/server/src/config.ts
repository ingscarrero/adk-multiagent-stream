/**
 * Server configuration, parsed once at startup.
 *
 * Parsing eagerly (rather than reading `process.env` at each use site) means a
 * misconfigured server fails on boot with a readable message instead of on the
 * first request with a confusing one.
 */

import { resolveModelMode, type ModelMode } from '@feed/agents';

export interface ServerConfig {
  port: number;
  corsOrigins: string[];
  modelMode: ModelMode;
  heartbeatMs: number;
  /**
   * How many events per session the replay buffer holds.
   *
   * Bounds memory, and bounds how far back a reconnecting client can resume.
   * A client disconnected for longer than this is sent a `resync` frame and
   * rebuilds from `GET /api/threads`; it recovers every thread's identity and
   * status, but the transcript of rolled-out events is genuinely gone.
   */
  replayBufferSize: number;
  /** Reconnect backoff advertised to the browser, in ms. */
  reconnectDelayMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env['PORT'] ?? 3001),
    corsOrigins: (env['CORS_ORIGIN'] ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    modelMode: resolveModelMode(env),
    heartbeatMs: Number(env['SSE_HEARTBEAT_MS'] ?? 15_000),
    replayBufferSize: Number(env['SSE_REPLAY_BUFFER'] ?? 500),
    reconnectDelayMs: Number(env['SSE_RETRY_MS'] ?? 1000),
  };
}
