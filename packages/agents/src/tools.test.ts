/**
 * Tool tests.
 *
 * The tools are deliberately boring; what is worth pinning is the contract
 * the agents and the eval harness rely on: fixture data that never changes,
 * zod validation in front of `execute`, and the confirmation gate on the one
 * tool that spends money. The gate is exercised through ADK's own
 * `FunctionTool.runAsync`, so these tests would notice if an ADK upgrade moved
 * where the pause happens.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@google/adk';
import type { KnowledgeProvider } from '@feed/providers';

// `TOOL_LATENCY_MS` is read once at import time, so it has to be pinned before
// the module loads. `vi.hoisted` runs ahead of the hoisted imports.
vi.hoisted(() => {
  process.env['TOOL_LATENCY_MS'] = '0';
});

const {
  ALL_TOOLS,
  REFUND_APPROVAL_THRESHOLD,
  checkShippingStatus,
  createSearchKnowledgeBase,
  lookupOrder,
  requestRefund,
} = await import('./tools.ts');

/** Runs a tool the way ADK does, with no confirmation context. */
const run = (tool: { runAsync(req: { args: Record<string, unknown>; toolContext: Context }): Promise<unknown> }, args: Record<string, unknown>) =>
  tool.runAsync({ args, toolContext: undefined as unknown as Context });

describe('ALL_TOOLS', () => {
  it('keys every tool by its declared name, which is what the eval harness looks up', () => {
    for (const [key, tool] of Object.entries(ALL_TOOLS)) {
      expect(tool.name).toBe(key);
    }
  });
});

describe('lookupOrder', () => {
  it('returns the fixture order, case-insensitively', async () => {
    await expect(run(lookupOrder, { orderId: 'a-1001' })).resolves.toMatchObject({
      found: true,
      orderId: 'a-1001',
      status: 'shipped',
      items: ['Mechanical keyboard'],
    });
  });

  it('reports a miss rather than throwing', async () => {
    await expect(run(lookupOrder, { orderId: 'Z-9999' })).resolves.toMatchObject({
      found: false,
      message: expect.stringContaining('Z-9999'),
    });
  });

  it('rejects arguments that do not match the schema before execute runs', async () => {
    await expect(run(lookupOrder, {})).rejects.toThrow();
  });
});

describe('checkShippingStatus', () => {
  it('is in transit for a shipped order', async () => {
    await expect(run(checkShippingStatus, { orderId: 'A-1001' })).resolves.toMatchObject({
      inTransit: true,
      lastScan: 'Departed regional hub',
      eta: '2026-09-02',
    });
  });

  it('is not in transit for a delivered order, with the final scan', async () => {
    await expect(run(checkShippingStatus, { orderId: 'A-1003' })).resolves.toMatchObject({
      inTransit: false,
      lastScan: 'Delivered to recipient',
    });
  });

  it.each(['A-1002', 'nope'])('says %s has not reached the carrier', async (orderId) => {
    await expect(run(checkShippingStatus, { orderId })).resolves.toMatchObject({
      inTransit: false,
      message: 'Not yet handed to the carrier.',
    });
  });
});

describe('searchKnowledgeBase', () => {
  // The spy is held separately so the assertions never reference the method
  // through the provider object (`@typescript-eslint/unbound-method`).
  const provider = () => {
    const search = vi.fn().mockResolvedValue([{ id: 'k1', title: 'Returns', body: '...', tags: [] }]);
    const knowledge: KnowledgeProvider = { mode: 'fake', search, close: () => Promise.resolve() };
    return { knowledge, search };
  };

  it('passes the query and limit to the configured provider and echoes the query', async () => {
    const { knowledge, search } = provider();
    const tool = createSearchKnowledgeBase(knowledge);

    await expect(run(tool, { query: 'warranty', limit: 2 })).resolves.toMatchObject({
      query: 'warranty',
      results: [{ id: 'k1' }],
    });
    expect(search).toHaveBeenCalledWith('warranty', 2);
  });

  it('defaults limit to 3 and caps it at 5, per the schema the model sees', async () => {
    const { knowledge, search } = provider();
    const tool = createSearchKnowledgeBase(knowledge);

    await run(tool, { query: 'returns' });
    expect(search).toHaveBeenLastCalledWith('returns', 3);

    await expect(run(tool, { query: 'returns', limit: 9 })).rejects.toThrow();
  });
});

describe('requestRefund — the confirmation gate', () => {
  it('needs approval strictly above the threshold', async () => {
    await expect(requestRefund.checkRequireConfirmation({ orderId: 'A-1001', amount: REFUND_APPROVAL_THRESHOLD, reason: 'x' })).resolves.toBe(false);
    await expect(requestRefund.checkRequireConfirmation({ orderId: 'A-1001', amount: REFUND_APPROVAL_THRESHOLD + 0.01, reason: 'x' })).resolves.toBe(true);
  });

  it('runs a small refund straight through', async () => {
    await expect(run(requestRefund, { orderId: 'A-1001', amount: 20, reason: 'late' })).resolves.toMatchObject({
      refunded: true,
      amount: 20,
      confirmationNumber: 'RF-A-1001',
    });
  });

  it('cannot run a large refund without a context to ask through', async () => {
    await expect(run(requestRefund, { orderId: 'A-1001', amount: 129.99, reason: 'damaged' })).rejects.toThrow(/requires confirmation/);
  });

  it('asks for confirmation instead of executing on the first pass', async () => {
    const toolContext = {
      toolConfirmation: undefined,
      requestConfirmation: vi.fn(),
      actions: {} as Record<string, unknown>,
    };
    const result = await requestRefund.runAsync({
      args: { orderId: 'A-1001', amount: 129.99, reason: 'damaged' },
      toolContext: toolContext as unknown as Context,
    });

    expect(result).toMatchObject({ error: expect.stringContaining('requires confirmation') });
    expect(toolContext.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(toolContext.actions['skipSummarization']).toBe(true);
  });

  it('refuses a denied refund without executing it', async () => {
    const result = await requestRefund.runAsync({
      args: { orderId: 'A-1001', amount: 129.99, reason: 'damaged' },
      toolContext: { toolConfirmation: { confirmed: false }, actions: {} } as unknown as Context,
    });
    expect(result).toEqual({ error: 'This tool call is rejected.' });
  });

  it('executes once approved', async () => {
    const result = await requestRefund.runAsync({
      args: { orderId: 'A-1001', amount: 129.99, reason: 'damaged' },
      toolContext: { toolConfirmation: { confirmed: true }, actions: {} } as unknown as Context,
    });
    expect(result).toMatchObject({ refunded: true, amount: 129.99 });
  });

  it('reports an unknown order rather than refunding it', async () => {
    await expect(run(requestRefund, { orderId: 'Z-1', amount: 5, reason: 'x' })).resolves.toMatchObject({
      refunded: false,
    });
  });
});
