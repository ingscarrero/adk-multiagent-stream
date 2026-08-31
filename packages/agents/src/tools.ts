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
/**
 * The one tool that spends the customer's money, and the only one gated on a
 * human.
 *
 * `requireConfirmation` is what makes `awaiting_input` reachable. ADK does not
 * run the tool on the first pass: it surfaces an `adk_request_confirmation`
 * interrupt instead, and the run pauses until someone answers. The tool body
 * below only ever executes after an approval.
 *
 * **A predicate, not a flag**, because that is the honest shape of the
 * requirement. Nobody wants to approve a $4 refund by hand, and everybody wants
 * to approve a $400 one. Gating on `amount` demonstrates the distinction the
 * ADK API exists to express &mdash; a boolean would have shown the mechanism
 * and hidden the reason for it.
 *
 * Note the threshold is evaluated against arguments ADK has already validated
 * against the zod schema, so `amount` is a number here rather than whatever the
 * model felt like emitting.
 */
export const REFUND_APPROVAL_THRESHOLD = 50;

export const requestRefund = new FunctionTool({
  name: 'requestRefund',
  description:
    'Issue a refund against an order. Refunds over $50 require the customer to confirm before they are applied.',
  parameters: z.object({
    orderId: z.string().describe('The order id to refund, for example A-1001.'),
    amount: z.number().positive().describe('Refund amount in US dollars.'),
    reason: z.string().describe('Why the refund is being issued.'),
  }),
  requireConfirmation: ({ amount }) => amount > REFUND_APPROVAL_THRESHOLD,
  async execute({ orderId, amount, reason }) {
    await sleep(TOOL_LATENCY_MS);
    const order = ORDERS[orderId.toUpperCase()];
    if (!order) {
      return { refunded: false, orderId, message: `No order matches ${orderId}.` };
    }
    // Deliberately not mutating ORDERS: fixed data is what keeps the evals
    // reproducible, and a refund that changed state would make test order
    // matter.
    return {
      refunded: true,
      orderId,
      amount,
      reason,
      confirmationNumber: `RF-${orderId.toUpperCase()}`,
    };
  },
});

export const ALL_TOOLS = {
  lookupOrder,
  searchKnowledgeBase,
  checkShippingStatus,
  requestRefund,
} as const;

export type ToolName = keyof typeof ALL_TOOLS;
