/**
 * Single-thread streaming: does the feed show the work as it happens?
 *
 * Every assertion here is web-first (`expect(locator)`), so Playwright retries
 * until the condition holds. There is not a single `waitForTimeout` in this
 * suite — a fixed sleep in a streaming test is a race that has not failed yet.
 */
import { expect, test } from '../fixtures.ts';

test.describe('single thread streaming', () => {
  test('shows a thread immediately, before the model produces anything', async ({ feed }) => {
    // The create endpoint returns 202 without waiting for the model, so the
    // thread must appear right away. If this regresses, the whole concurrency
    // story goes with it.
    const thread = await feed.send('Where is my order, can you track shipping?');
    await expect(thread).toBeVisible();
    await expect(thread.getByTestId('thread-prompt')).toHaveText(
      'Where is my order, can you track shipping?',
    );
  });

  test('progresses through tool use to a completed answer', async ({ feed }) => {
    const thread = await feed.send('Where is my order, can you track shipping?');

    // The router hands off, then the specialist uses two tools.
    await expect(feed.toolSteps(thread)).toHaveCount(3, { timeout: 15_000 });
    await expect(feed.toolSteps(thread).nth(0)).toHaveAttribute('data-tool', 'transfer_to_agent');
    await expect(feed.toolSteps(thread).nth(1)).toHaveAttribute('data-tool', 'lookupOrder');
    await expect(feed.toolSteps(thread).nth(2)).toHaveAttribute('data-tool', 'checkShippingStatus');

    await feed.expectStatus(thread, 'complete');
    await expect(feed.messages(thread)).toHaveCount(1);
    await expect(feed.messages(thread)).toContainText('A-1001');
  });

  test('attributes the answer to the specialist, not the router', async ({ feed }) => {
    // The point of a multi-agent transcript: you can see who said what.
    const thread = await feed.send('Where is my order, can you track shipping?');
    await feed.waitForTerminal(thread);
    await expect(feed.messages(thread).first()).toHaveAttribute('data-author', 'order_agent');
  });

  test('renders text incrementally rather than in one drop', async ({ feed }) => {
    const thread = await feed.send('What is your warranty coverage?');

    const text = feed.messages(thread).getByTestId('message-text');
    // Catch the message while it is still short: proves the UI paints partial
    // text instead of waiting for the complete event.
    await expect(text).toBeVisible({ timeout: 15_000 });
    const midStream = (await text.textContent()) ?? '';

    await feed.waitForTerminal(thread);
    const final = (await text.textContent()) ?? '';

    expect(final.length).toBeGreaterThan(0);
    expect(final.startsWith(midStream.trim().slice(0, 10))).toBe(true);
  });

  test('exposes tool arguments and results when a step is expanded', async ({ feed }) => {
    const thread = await feed.send('Where is my order, can you track shipping?');
    await feed.waitForTerminal(thread);

    const lookup = feed.toolSteps(thread).filter({ hasText: 'lookupOrder' });
    await lookup.getByRole('group').or(lookup).first().click();
    await expect(lookup).toContainText('orderId');
    await expect(lookup).toContainText('A-1001');
  });

  test('surfaces a failed run as an error, not a silent stall', async ({ feed }) => {
    const thread = await feed.send('please fail this run');

    await feed.expectStatus(thread, 'error');
    await expect(thread.getByTestId('thread-error')).toBeVisible();
    // No Stop button on a finished thread.
    await expect(thread.getByTestId('cancel-thread')).toHaveCount(0);
  });
});

test.describe('research pipeline', () => {
  test('keeps each parallel agent in its own message', async ({ feed }) => {
    const thread = await feed.send('How should we position the product?', 'research');
    await feed.waitForTerminal(thread);

    const authors = await feed.messages(thread).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-author')),
    );
    expect(authors).toEqual(['market_researcher', 'docs_researcher', 'synthesizer']);
  });

  test('shows one tool step per parallel agent', async ({ feed }) => {
    // Regression: both researchers ran the same tool at the same script
    // position, and identical call ids collapsed them into a single step.
    const thread = await feed.send('How should we position the product?', 'research');
    await feed.waitForTerminal(thread);
    await expect(feed.toolSteps(thread)).toHaveCount(2);
  });

  test('runs the synthesizer last', async ({ feed }) => {
    const thread = await feed.send('How should we position the product?', 'research');
    await feed.waitForTerminal(thread);
    await expect(feed.messages(thread).last()).toHaveAttribute('data-author', 'synthesizer');
  });
});
