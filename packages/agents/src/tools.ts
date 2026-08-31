/**
 * The tools our agents can call.
 *
 * Kept intentionally boring and synchronous-ish: the point of this repo is the
 * streaming feed, not the tools. What matters here is that each tool has a zod
 * `parameters` schema — ADK derives the model-facing function declaration from
 * it, and the same schema validates the model's arguments before `execute` runs.
 *
 * Every tool sleeps a little. Real tools are slow, and a feed that has never
 * rendered an `awaiting_tool` state has not been tested.
 */

import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { keywordKnowledge, type KnowledgeProvider } from '@feed/providers';

/** Deterministic fake latency so tool states are observable in the UI and in tests. */
const TOOL_LATENCY_MS = Number(process.env['TOOL_LATENCY_MS'] ?? 150);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tiny in-memory order book. Fixed data keeps evals reproducible. */
const ORDERS: Record<string, { status: string; items: string[]; eta: string }> = {
  'A-1001': { status: 'shipped', items: ['Mechanical keyboard'], eta: '2026-09-02' },
  'A-1002': { status: 'processing', items: ['USB-C hub', 'Cable'], eta: '2026-09-05' },
  'A-1003': { status: 'delivered', items: ['Monitor arm'], eta: '2026-08-24' },
};


export const lookupOrder = new FunctionTool({
  name: 'lookupOrder',
  description: 'Look up an order by its id and return status, items, and estimated delivery date.',
  parameters: z.object({
    orderId: z.string().describe('The order id, for example A-1001.'),
  }),
  async execute({ orderId }) {
    await sleep(TOOL_LATENCY_MS);
    const order = ORDERS[orderId.toUpperCase()];
    if (!order) {
      return { found: false, orderId, message: `No order matches ${orderId}.` };
    }
    return { found: true, orderId, ...order };
  },
});

/**
 * Builds the knowledge tool over whichever retrieval provider is configured.
 *
 * The tool's shape &mdash; its name, description and parameters, which is all
 * the model ever sees &mdash; is identical whether the provider behind it is
 * keyword matching over fixtures or a vector search. That is the whole point of
 * the port: swapping retrieval does not change the agent.
 */
export function createSearchKnowledgeBase(knowledge: KnowledgeProvider) {
  return new FunctionTool({
    name: 'searchKnowledgeBase',
    description: 'Search the support knowledge base for articles matching a query.',
    parameters: z.object({
      query: z.string().describe('Free-text search query.'),
      limit: z.number().int().min(1).max(5).default(3).describe('Maximum articles to return.'),
    }),
    async execute({ query, limit }) {
      await sleep(TOOL_LATENCY_MS);
      return { query, results: await knowledge.search(query, limit) };
    },
  });
}

/** The default instance, backed by the emulated keyword provider. */
export const searchKnowledgeBase = createSearchKnowledgeBase(keywordKnowledge());

export const checkShippingStatus = new FunctionTool({
  name: 'checkShippingStatus',
  description: 'Check the live carrier status for a shipped order.',
  parameters: z.object({
    orderId: z.string().describe('The order id, for example A-1001.'),
  }),
  async execute({ orderId }) {
    await sleep(TOOL_LATENCY_MS);
    const order = ORDERS[orderId.toUpperCase()];
    if (!order || order.status === 'processing') {
      return { orderId, inTransit: false, message: 'Not yet handed to the carrier.' };
    }
    return {
      orderId,
      inTransit: order.status === 'shipped',
      lastScan: order.status === 'delivered' ? 'Delivered to recipient' : 'Departed regional hub',
      eta: order.eta,
    };
  },
});

/** Every tool, by name — used by the eval harness to validate expected trajectories. */
export const ALL_TOOLS = { lookupOrder, searchKnowledgeBase, checkShippingStatus } as const;

export type ToolName = keyof typeof ALL_TOOLS;
