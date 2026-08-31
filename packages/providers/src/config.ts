/**
 * Provider selection from the environment.
 *
 * One variable per capability, `PROVIDER_<NAME>`, defaulting to the emulated
 * adapter so the repo runs with no configuration at all. A mode that needs a
 * connection string fails here, at startup, with a message naming the variable
 * &mdash; not later, on the first request that happens to touch it.
 */

import { CAPABILITIES } from './catalog.ts';

export type SessionsMode = 'memory' | 'postgres';
export type KnowledgeMode = 'keyword' | 'vector';
export type IdentityMode = 'trusted-header' | 'jwt';

export interface ProviderConfig {
  sessions: SessionsMode;
  knowledge: KnowledgeMode;
  identity: IdentityMode;
  /** Required by `sessions=postgres` and `knowledge=vector`. */
  databaseUrl?: string;
  /** Required by `identity=jwt`. */
  jwtSecret?: string;
}

function pick<T extends string>(
  env: NodeJS.ProcessEnv,
  variable: string,
  allowed: readonly string[],
  fallback: T,
): T {
  const value = env[variable];
  if (value === undefined || value === '') return fallback;
  if (!allowed.includes(value)) {
    throw new Error(
      `${variable} must be one of ${allowed.join(' | ')}, got "${value}".`,
    );
  }
  return value as T;
}

export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const sessions = pick<SessionsMode>(
    env, 'PROVIDER_SESSIONS',
    [CAPABILITIES.sessions.emulated, ...CAPABILITIES.sessions.real], 'memory',
  );
  const knowledge = pick<KnowledgeMode>(
    env, 'PROVIDER_KNOWLEDGE',
    [CAPABILITIES.knowledge.emulated, ...CAPABILITIES.knowledge.real], 'keyword',
  );
  const identity = pick<IdentityMode>(
    env, 'PROVIDER_IDENTITY',
    [CAPABILITIES.identity.emulated, ...CAPABILITIES.identity.real], 'trusted-header',
  );

  const databaseUrl = env['DATABASE_URL'];
  const jwtSecret = env['JWT_SECRET'];

  // Fail at startup, naming the variable, rather than on first use.
  if ((sessions === 'postgres' || knowledge === 'vector') && !databaseUrl) {
    throw new Error(
      `PROVIDER_SESSIONS=postgres and PROVIDER_KNOWLEDGE=vector require DATABASE_URL. See docs/PROVIDERS.md.`,
    );
  }
  if (identity === 'jwt' && !jwtSecret) {
    throw new Error('PROVIDER_IDENTITY=jwt requires JWT_SECRET. See docs/PROVIDERS.md.');
  }

  return {
    sessions,
    knowledge,
    identity,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(jwtSecret ? { jwtSecret } : {}),
  };
}
