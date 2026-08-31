/**
 * The heart of the exercise: several threads streaming at once.
 *
 * What these tests protect is that threads are *independent* — separate
 * statuses, separate transcripts, separate ordering — while sharing one
 * connection. A feed that serialises threads would pass a naive "it streams"
 * test and fail every one of these.
 */
import { expect, test } from '../fixtures.ts';

const ORDER = 'Where is my order, can you track shipping?';
const WARRANTY = 'What is your warranty coverage?';
const RESEARCH = 'How should we position the product?';

test.describe('concurrent threads', () => {
  test('accepts a second prompt while the first is still streaming', async ({ feed }) => {
    const first = await feed.send(ORDER);
    // Do not wait for the first to finish — that is the whole point.
    const second = await feed.send(WARRANTY);

    await expect(feed.threads).toHaveCount(2);
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
  });

  test('runs three threads to completion with independent transcripts', async ({ feed }) => {
    const order = await feed.send(ORDER);
    const warranty = await feed.send(WARRANTY);
    const research = await feed.send(RESEARCH, 'research');

    await expect(feed.threads).toHaveCount(3);

    for (const thread of [order, warranty, research]) {
      expect(await feed.waitForTerminal(thread)).toBe('complete');
    }

    // Each thread answered its own question, with nothing bleeding across.
    await expect(feed.messages(order)).toContainText('A-1001');
    await expect(feed.messages(warranty)).toContainText('warranty');
    await expect(feed.messages(research).last()).toContainText('Synthesis');
  });

  test('tracks the active count as threads start and finish', async ({ feed }) => {
    const first = await feed.send(ORDER);
    const second = await feed.send(WARRANTY);

    await expect(feed.activeCount).toHaveText('2 active');

    await feed.waitForTerminal(first);
    await feed.waitForTerminal(second);
    await expect(feed.activeCount).toHaveText('0 active');
  });

  test('lets one thread finish while another is still running', async ({ feed }) => {
    // The research pipeline is the longer run; the router thread should be able
    // to complete underneath it rather than queueing behind it.
    const research = await feed.send(RESEARCH, 'research');
    const quick = await feed.send('hello there');

    await feed.expectStatus(quick, 'complete');
    // Independent lifecycles: `quick` is done, `research` need not be.
    expect(await feed.waitForTerminal(research)).toBe('complete');
  });

  test('keeps message text uncorrupted across interleaved threads', async ({ feed }) => {
    // If ordering were global rather than per-thread, interleaved deltas would
    // splice one thread's words into another's message.
    const order = await feed.send(ORDER);
    const warranty = await feed.send(WARRANTY);

    await feed.waitForTerminal(order);
    await feed.waitForTerminal(warranty);

    const orderText = (await feed.transcript(order)).join(' ');
    const warrantyText = (await feed.transcript(warranty)).join(' ');

    expect(orderText).toContain('A-1001');
    expect(orderText).not.toContain('warranty');
    expect(warrantyText).toContain('warranty');
    expect(warrantyText).not.toContain('A-1001');
  });

  test('renders threads oldest first, matching the scroll direction', async ({ feed }) => {
    await feed.send(ORDER);
    await feed.send(WARRANTY);
    // Threads arrive over the stream, not from the POST response, so wait for
    // both to land before reading the order.
    await expect(feed.threads).toHaveCount(2);

    const prompts = await feed.threads.getByTestId('thread-prompt').allTextContents();
    expect(prompts).toEqual([ORDER, WARRANTY]);
  });
});
