/**
 * Emulated session store: ADK's own in-process implementation.
 *
 * Everything is lost on restart, which is fine for a boilerplate and is the
 * reason `docs/LIMITATIONS.md` L7 exists. The real adapter is
 * `DatabaseSessionService`, which takes a connection string and nothing else
 * &mdash; ADK made this the cheapest possible swap.
 */

import { InMemorySessionService } from '@google/adk';
import type { SessionProvider } from '../ports.ts';

export function memorySessions(): SessionProvider {
  const service = new InMemorySessionService();
  return {
    mode: 'memory',
    service: () => service,
    close: () => Promise.resolve(),
  };
}
