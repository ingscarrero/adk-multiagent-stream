/**
 * `@feed/providers` &mdash; the emulated/real substrate boundary.
 *
 * Every capability this app does not implement itself lives behind a port here,
 * with an emulated adapter that needs nothing installed and a real adapter
 * behind a config flag. See docs/PROVIDERS.md for what each stands in for.
 */

import { loadProviderConfig, type ProviderConfig } from './config.ts';
import { memorySessions } from './sessions/memory.ts';
import { keywordKnowledge } from './knowledge/keyword.ts';
import { trustedHeaderIdentity } from './identity/trusted-header.ts';
import { memoryEventStream } from './eventstream/memory.ts';
import type { Providers } from './ports.ts';

export * from './catalog.ts';
export * from './config.ts';
export * from './ports.ts';
export * from './eventstream/port.ts';
export { memoryEventStream } from './eventstream/memory.ts';
export { keywordKnowledge, FIXTURE_ARTICLES } from './knowledge/keyword.ts';
export { memorySessions } from './sessions/memory.ts';
export { trustedHeaderIdentity } from './identity/trusted-header.ts';

/**
 * Builds the providers for one process.
 *
 * Real adapters are added here as they land; the emulated ones are the default
 * so that a clone with no configuration still runs.
 */
export function resolveProviders(config: ProviderConfig = loadProviderConfig()): Providers {
  const sessions = memorySessions();
  const knowledge = keywordKnowledge();
  const identity = trustedHeaderIdentity();
  const eventStream = memoryEventStream({ retention: config.eventRetention });

  if (config.sessions !== 'memory') {
    throw new Error(
      `PROVIDER_SESSIONS=${config.sessions} is catalogued but not implemented yet. See docs/PROVIDERS.md.`,
    );
  }
  if (config.knowledge !== 'keyword') {
    throw new Error(
      `PROVIDER_KNOWLEDGE=${config.knowledge} is catalogued but not implemented yet. See docs/PROVIDERS.md.`,
    );
  }
  if (config.identity !== 'trusted-header') {
    throw new Error(
      `PROVIDER_IDENTITY=${config.identity} is catalogued but not implemented yet. See docs/PROVIDERS.md.`,
    );
  }
  if (config.eventStream !== 'memory') {
    throw new Error(
      `PROVIDER_EVENTSTREAM=${config.eventStream} is catalogued but not implemented yet. See docs/PROVIDERS.md.`,
    );
  }

  return {
    sessions,
    knowledge,
    identity,
    eventStream,
    async close() {
      await Promise.all([
        sessions.close(),
        knowledge.close(),
        identity.close(),
        eventStream.close(),
      ]);
    },
  };
}
