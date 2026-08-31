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

/** Deterministic fake latency so tool states are observable in the UI and in tests. */
const TOOL_LATENCY_MS = Number(process.env['TOOL_LATENCY_MS'] ?? 150);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tiny in-memory order book. Fixed data keeps evals reproducible. */
const ORDERS: Record<string, { status: string; items: string[]; eta: string }> = {
  'A-1001': { status: 'shipped', items: ['Mechanical keyboard'], eta: '2026-09-02' },
  'A-1002': { status: 'processing', items: ['USB-C hub', 'Cable'], eta: '2026-09-05' },
  'A-1003': { status: 'delivered', items: ['Monitor arm'], eta: '2026-08-24' },
};

const KB: Array<{ id: string; title: string; body: string; tags: string[] }> = [
  {
    id: 'kb-returns',
    title: 'Return policy',
    body: 'Unopened items may be returned within 30 days for a full refund. Opened items incur a 15% restocking fee.',
    tags: ['return', 'refund', 'policy'],
  },
  {
    id: 'kb-shipping',
    title: 'Shipping times',
    body: 'Standard shipping is 3-5 business days. Express is next business day when ordered before 2pm.',
    tags: ['shipping', 'delivery', 'time'],
  },
  {
    id: 'kb-warranty',
    title: 'Warranty coverage',
    body: 'Hardware carries a 2 year limited warranty covering manufacturing defects, not accidental damage.',
    tags: ['warranty', 'repair', 'defect'],
  },
];

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

export const searchKnowledgeBase = new FunctionTool({
  name: 'searchKnowledgeBase',
  description: 'Search the support knowledge base for articles matching a query.',
  parameters: z.object({
    query: z.string().describe('Free-text search query.'),
    limit: z.number().int().min(1).max(5).default(3).describe('Maximum articles to return.'),
  }),
  async execute({ query, limit }) {
    await sleep(TOOL_LATENCY_MS);
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    const scored = KB.map((article) => ({
      article,
      score: terms.filter(
        (term) => article.tags.some((tag) => tag.includes(term)) || article.title.toLowerCase().includes(term),
      ).length,
    }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { query, results: scored.map(({ article }) => article) };
  },
});

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
