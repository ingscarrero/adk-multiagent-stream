/**
 * Server configuration, parsed once at startup.
 *
 * Parsing eagerly (rather than reading `process.env` at each use site) means a
 * misconfigured server fails on boot with a readable message instead of on the
 * first request with a confusing one.
 */

import { resolveModelMode, type ModelMode } from '@feed/agents';
import { loadProviderConfig, type ProviderConfig } from '@feed/providers';

export interface ServerConfig {
  port: number;
  corsOrigins: string[];
  modelMode: ModelMode;
  heartbeatMs: number;
  /** Reconnect backoff advertised to the browser, in ms. */
  reconnectDelayMs: number;
  /** Bytes queued for one subscriber before it is disconnected. See L2. */
  maxBufferedBytes: number;
  /** How long an unwatched session may sit before it is swept. See L3. */
  idleTtlMs: number;
  /** How often to sweep. */
  sweepIntervalMs: number;
  /**
   * Which adapter backs each capability the app does not implement itself.
   *
   * Emulated by default so a clone runs with no services. See
   * docs/PROVIDERS.md for what each one stands in for.
   */
  providers: ProviderConfig;
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
    reconnectDelayMs: Number(env['SSE_RETRY_MS'] ?? 1000),
    // 1 MiB is roughly forty seconds of a busy feed. Large enough that a brief
    // stall is absorbed rather than punished, small enough that a hundred
    // stalled clients cannot exhaust a small container.
    maxBufferedBytes: Number(env['SSE_MAX_BUFFERED_BYTES'] ?? 1_048_576),
    idleTtlMs: Number(env['SESSION_IDLE_TTL_MS'] ?? 900_000),
    sweepIntervalMs: Number(env['SESSION_SWEEP_INTERVAL_MS'] ?? 60_000),
    providers: loadProviderConfig(env),
  };
}
