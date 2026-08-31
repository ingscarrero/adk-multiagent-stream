/**
 * Provider tests.
 *
 * Two kinds. Config tests pin the failure behaviour: a bad mode or a missing
 * connection string must fail at startup, naming the variable, rather than on
 * the first request that happens to touch it. Contract tests describe what any
 * adapter of a port must do, so a real adapter can be held to the same suite.
 */
import { describe, expect, it } from 'vitest';
import { describeCapabilities, isFullyEmulated, CAPABILITIES } from './catalog.ts';
import { loadProviderConfig } from './config.ts';
import { keywordKnowledge, FIXTURE_ARTICLES } from './knowledge/keyword.ts';
import { trustedHeaderIdentity } from './identity/trusted-header.ts';
import { memorySessions } from './sessions/memory.ts';
import { resolveProviders } from './index.ts';
import type { IdentityRequest, KnowledgeProvider } from './ports.ts';

describe('provider config', () => {
  it('defaults every capability to its emulated adapter', () => {
    // A clone with no configuration must run, so the zero-env case is the
    // fully-emulated case.
    expect(loadProviderConfig({})).toEqual({
      sessions: 'memory',
      knowledge: 'keyword',
      identity: 'trusted-header',
      eventStream: 'memory',
      eventRetention: 500,
    });
  });

  it('rejects an unknown mode by naming the variable and the options', () => {
    expect(() => loadProviderConfig({ PROVIDER_SESSIONS: 'mongo' })).toThrowError(
      /PROVIDER_SESSIONS must be one of memory \| postgres/,
    );
  });

  it('requires a connection string before a store-backed mode can start', () => {
    expect(() => loadProviderConfig({ PROVIDER_SESSIONS: 'postgres' })).toThrowError(
      /DATABASE_URL/,
    );
    expect(() => loadProviderConfig({ PROVIDER_KNOWLEDGE: 'vector' })).toThrowError(
      /DATABASE_URL/,
    );
    expect(() => loadProviderConfig({ PROVIDER_IDENTITY: 'jwt' })).toThrowError(/JWT_SECRET/);
    expect(() => loadProviderConfig({ PROVIDER_EVENTSTREAM: 'redis' })).toThrowError(/REDIS_URL/);
  });

  it('accepts a real mode once its configuration is present', () => {
    expect(
      loadProviderConfig({ PROVIDER_SESSIONS: 'postgres', DATABASE_URL: 'postgres://x' }),
    ).toMatchObject({ sessions: 'postgres', databaseUrl: 'postgres://x' });
  });

  it('treats an empty string as unset rather than invalid', () => {
    // Empty environment variables are what an unset shell variable expands to.
    expect(loadProviderConfig({ PROVIDER_SESSIONS: '' }).sessions).toBe('memory');
  });
});

describe('capability catalogue', () => {
  it('reports the emulated flag per capability', () => {
    const rows = describeCapabilities({
      model: 'scripted',
      sessions: 'memory',
      knowledge: 'keyword',
      identity: 'trusted-header',
      eventStream: 'memory',
    });
    expect(isFullyEmulated(rows)).toBe(true);
    expect(rows.every((r) => r.options.length >= 2)).toBe(true);
  });

  it('marks a real mode as not emulated', () => {
    const rows = describeCapabilities({
      model: 'gemini',
      sessions: 'memory',
      knowledge: 'keyword',
      identity: 'trusted-header',
      eventStream: 'memory',
    });
    expect(rows.find((r) => r.capability === 'model')?.emulated).toBe(false);
    expect(isFullyEmulated(rows)).toBe(false);
  });

  it('treats storage and delivery as one capability', () => {
    // They were two rows once. Only two of the four combinations are coherent
    // and every real provider serves both from one primitive, so the split
    // advertised a seam that does not exist.
    expect(CAPABILITIES.eventStream.switchable).toBe(true);
    expect(CAPABILITIES.eventStream.real).toContain('redis');
    expect('fanout' in CAPABILITIES).toBe(false);
  });
});

/**
 * The contract every knowledge adapter must satisfy.
 *
 * Written against the port, not the implementation, so a vector adapter can be
 * run through the identical suite and any divergence shows up as a failure
 * rather than a surprise in production.
 */
function knowledgeContract(name: string, make: () => KnowledgeProvider) {
  describe(`KnowledgeProvider contract: ${name}`, () => {
    it('returns articles matching an obvious query', async () => {
      const results = await make().search('warranty', 3);
      expect(results.map((a) => a.id)).toContain('kb-warranty');
    });

    it('honours the limit', async () => {
      expect(await make().search('policy shipping warranty', 1)).toHaveLength(1);
    });

    it('returns an empty array rather than throwing on no match', async () => {
      expect(await make().search('zzzz-no-such-topic', 3)).toEqual([]);
    });

    it('returns whole articles, so an agent can ground an answer', async () => {
      const [article] = await make().search('warranty', 1);
      expect(article).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        body: expect.any(String),
      });
    });
  });
}

knowledgeContract('keyword', () => keywordKnowledge());

describe('keyword knowledge, specifically', () => {
  it('is deterministic, which is what lets the evals assert on tool output', async () => {
    const a = await keywordKnowledge().search('warranty', 3);
    const b = await keywordKnowledge().search('warranty', 3);
    expect(a).toEqual(b);
  });

  // The three pathologies below are why this adapter is named as the emulation
  // most easily mistaken for the real thing. Each is asserted rather than
  // described, so nobody has to take the claim on trust.

  it('misses the plural of a word it matches in the singular', async () => {
    expect(await keywordKnowledge().search('return', 3)).toHaveLength(1);
    // A substring test in the wrong direction: 'return'.includes('returns') is
    // false, so adding one letter loses the document entirely.
    expect(await keywordKnowledge().search('returns', 3)).toEqual([]);
  });

  it('returns everything for a natural-language question, which is noise not recall', async () => {
    // "I" survives tokenisation as a single character, and every tag
    // containing an "i" matches it. The agent gets all three articles and no
    // signal about which is relevant.
    const results = await keywordKnowledge().search('how long do I have to send it back', 3);
    expect(results).toHaveLength(3);
    expect(await keywordKnowledge().search('i', 3)).toHaveLength(3);
  });

  it('finds nothing for a genuine paraphrase', async () => {
    // A plain restatement of the returns policy sharing no literal token with
    // it. A vector search finds this; keyword matching cannot.
    expect(await keywordKnowledge().search('send this back for money', 3)).toEqual([]);
  });

  it('accepts injected articles, so tests need not depend on the fixtures', async () => {
    const custom = keywordKnowledge([
      { id: 'x', title: 'Bicycle', body: 'about bikes', tags: ['bicycle'] },
    ]);
    expect(await custom.search('bicycle', 3)).toHaveLength(1);
    expect(FIXTURE_ARTICLES).toHaveLength(3);
  });
});

describe('trusted-header identity', () => {
  const request = (header?: string, query: Record<string, unknown> = {}): IdentityRequest => ({
    header: (name) => (name === 'x-session-id' ? header : undefined),
    query,
  });

  it('prefers the header', async () => {
    const identity = await trustedHeaderIdentity().resolve(request('from-header', { sessionId: 'from-query' }));
    expect(identity?.sessionId).toBe('from-header');
  });

  it('falls back to the query parameter, because EventSource cannot send headers', async () => {
    const identity = await trustedHeaderIdentity().resolve(request(undefined, { sessionId: 'q' }));
    expect(identity?.sessionId).toBe('q');
  });

  it('returns null when there is nothing to go on', async () => {
    expect(await trustedHeaderIdentity().resolve(request())).toBeNull();
  });

  it('carries no subject, because it authenticates nothing', async () => {
    const identity = await trustedHeaderIdentity().resolve(request('s'));
    expect(identity?.subject).toBeUndefined();
  });
});

describe('resolveProviders', () => {
  it('builds the emulated set by default', async () => {
    const providers = resolveProviders(loadProviderConfig({}));
    expect(providers.sessions.mode).toBe('memory');
    expect(providers.knowledge.mode).toBe('keyword');
    expect(providers.identity.mode).toBe('trusted-header');
    expect(providers.eventStream.mode).toBe('memory');
    await providers.close();
  });

  it('says plainly when a catalogued mode is not implemented yet', () => {
    expect(() =>
      resolveProviders({
        sessions: 'postgres',
        knowledge: 'keyword',
        identity: 'trusted-header',
        eventStream: 'memory',
        eventRetention: 500,
        databaseUrl: 'postgres://x',
      }),
    ).toThrowError(/not implemented yet/);
  });

  it('closes every provider it built', async () => {
    const providers = resolveProviders(loadProviderConfig({}));
    await expect(providers.close()).resolves.toBeUndefined();
  });

  it('gives a session service ADK can use', () => {
    const service = memorySessions().service();
    expect(typeof service.createSession).toBe('function');
  });
});
