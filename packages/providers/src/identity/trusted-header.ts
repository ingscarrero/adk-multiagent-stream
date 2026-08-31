/**
 * Emulated identity: believe whatever the caller says it is.
 *
 * The session id arrives in a header or a query parameter and is trusted
 * completely. Anyone who guesses another session's id can read that feed, so
 * this is not authentication &mdash; it is a placeholder shaped like it
 * (`docs/LIMITATIONS.md` L9).
 *
 * The query parameter is not laziness: `EventSource` cannot send custom
 * headers, so the SSE endpoint has no other way to carry it. A real deployment
 * puts a token in a cookie, or uses `fetch` streaming instead of `EventSource`.
 */

import type { IdentityProvider } from '../ports.ts';

export function trustedHeaderIdentity(): IdentityProvider {
  return {
    mode: 'trusted-header',
    resolve(request) {
      const fromHeader = request.header('x-session-id');
      if (fromHeader) return Promise.resolve({ sessionId: fromHeader });

      const fromQuery = request.query['sessionId'];
      return Promise.resolve(
        typeof fromQuery === 'string' && fromQuery.length > 0
          ? { sessionId: fromQuery }
          : null,
      );
    },
    close: () => Promise.resolve(),
  };
}
