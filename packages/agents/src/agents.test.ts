/**
 * End-to-end checks that our agent trees actually run under a real ADK Runner.
 *
 * These are the load-bearing tests of the whole repo: if agent transfer or
 * parallel fan-out do not behave as assumed here, the feed's ordering and
 * status logic is built on sand. They use `InMemoryRunner` and the scripted
 * model, so they are fast and hermetic.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRunner, StreamingMode, type Event } from '@google/adk';
import { createAgent } from './agents.ts';

async function run(agentId: 'router' | 'research', prompt: string): Promise<Event[]> {
  const runner = new InMemoryRunner({
    agent: createAgent(agentId, { mode: 'scripted', chunkDelayMs: 0 }),
    appName: 'test',
  });
  const events: Event[] = [];
  for await (const event of runner.runEphemeral({
    userId: 'u1',
    newMessage: { role: 'user', parts: [{ text: prompt }] },
    runConfig: { streamingMode: StreamingMode.SSE },
  })) {
    events.push(event);
  }
  return events;
}

const textOf = (event: Event) => (event.content?.parts ?? []).map((p) => p.text ?? '').join('');
const authorsOf = (events: Event[]) => [...new Set(events.map((e) => e.author).filter(Boolean))];
const toolCallsOf = (events: Event[]) =>
  events.flatMap((e) => (e.content?.parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall.name!] : [])));

describe('router agent', () => {
  it('transfers an order question to order_agent and answers with tools', async () => {
    const events = await run('router', 'where is my order, can you track shipping?');

    expect(toolCallsOf(events)).toContain('transfer_to_agent');
    expect(authorsOf(events)).toContain('order_agent');
    // Both order tools are used, in script order.
    const tools = toolCallsOf(events).filter((n) => n !== 'transfer_to_agent');
    expect(tools).toEqual(['lookupOrder', 'checkShippingStatus']);

    const final = events.filter((e) => !e.partial).map(textOf).join(' ');
    expect(final).toMatch(/A-1001/);
  });

  it('transfers a policy question to kb_agent', async () => {
    const events = await run('router', 'what is your return and refund policy?');
    expect(authorsOf(events)).toContain('kb_agent');
    expect(toolCallsOf(events)).toContain('searchKnowledgeBase');
  });

  it('answers directly when nothing matches, without transferring', async () => {
    const events = await run('router', 'hello there');
    expect(toolCallsOf(events)).not.toContain('transfer_to_agent');
    expect(authorsOf(events)).toEqual(['support_router']);
  });

  it('surfaces a model error as an event carrying errorCode', async () => {
    const events = await run('router', 'please fail');
    expect(events.some((e) => e.errorCode === 'SCRIPTED_ERROR')).toBe(true);
  });

  it('emits partial events before the final one when streaming', async () => {
    const events = await run('router', 'hello there');
    expect(events.some((e) => e.partial)).toBe(true);
    expect(events.at(-1)?.partial).toBeFalsy();
  });
});

describe('research pipeline', () => {
  it('runs both researchers and then the synthesizer', async () => {
    const events = await run('research', 'how should we position the product?');
    const authors = authorsOf(events);

    expect(authors).toContain('market_researcher');
    expect(authors).toContain('docs_researcher');
    expect(authors).toContain('synthesizer');
  });

  it('interleaves the two parallel branches rather than running them serially', async () => {
    // The property the feed's per-thread `seq` exists to survive: two authors
    // producing events that are NOT grouped into two contiguous blocks.
    const events = await run('research', 'how should we position the product?');
    const branchAuthors = events
      .map((e) => e.author)
      .filter((a): a is string => a === 'market_researcher' || a === 'docs_researcher');

    const switches = branchAuthors.filter((a, i) => i > 0 && a !== branchAuthors[i - 1]).length;
    expect(switches).toBeGreaterThan(1);
  });

  it('runs the synthesizer strictly after both researchers finish', async () => {
    const events = await run('research', 'how should we position the product?');
    const firstSynth = events.findIndex((e) => e.author === 'synthesizer');
    const lastResearcher = events.findLastIndex(
      (e) => e.author === 'market_researcher' || e.author === 'docs_researcher',
    );
    expect(firstSynth).toBeGreaterThan(lastResearcher);
  });

  it('gives every event a branch path identifying its position in the tree', async () => {
    const events = await run('research', 'how should we position the product?');
    const branches = new Set(events.map((e) => e.branch).filter(Boolean));
    expect(branches.size).toBeGreaterThan(0);
  });
});
