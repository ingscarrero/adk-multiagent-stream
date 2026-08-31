/**
 * Cancellation and reconnect: what happens when things go wrong mid-stream.
 *
 * These are the tests that justify the protocol design. Everything about
 * `Last-Event-ID`, the replay buffer, and the terminal-status guarantee exists
 * for the scenarios below, and without them those mechanisms are just untested
 * complexity.
 */
import { allowConsoleError, expect, test } from '../fixtures.ts';

const RESEARCH = 'How should we position the product?';

test.describe('cancellation', () => {
  test('stops a running thread and marks it cancelled', async ({ feed }) => {
    const thread = await feed.send(RESEARCH, 'research');

    // Cancel as soon as the run is genuinely under way.
    await expect(thread).not.toHaveAttribute('data-status', 'queued');
    await feed.cancel(thread);

    await feed.expectStatus(thread, 'cancelled');
    // The Stop button disappears once the thread is terminal.
    await expect(thread.getByTestId('cancel-thread')).toHaveCount(0);
  });

  test('leaves no message stuck in a streaming state after cancelling', async ({ feed }) => {
    // The `finally` in ThreadRunner closes open messages. Without it the caret
    // blinks forever on a thread that is already finished.
    const thread = await feed.send(RESEARCH, 'research');
    await expect(feed.messages(thread).first()).toBeVisible({ timeout: 15_000 });

    await feed.cancel(thread);
    await feed.expectStatus(thread, 'cancelled');

    await expect(feed.messages(thread).filter({ has: thread.locator('[data-streaming="true"]') }))
      .toHaveCount(0);
  });

  test('does not affect other threads', async ({ feed }) => {
    // Start the survivor first, so the only delay between creating the doomed
    // thread and cancelling it is the click itself. Sending the survivor in
    // between gave the research pipeline time to finish on slower machines,
    // and Stop had already been removed by the time the click landed.
    const survivor = await feed.send('What is your warranty coverage?');
    const doomed = await feed.send(RESEARCH, 'research');

    await feed.cancel(doomed);
    await feed.expectStatus(doomed, 'cancelled');
    expect(await feed.waitForTerminal(survivor)).toBe('complete');
  });
});

test.describe('reconnect and replay', () => {
  test('restores the full feed after a page reload', async ({ feed, page }) => {
    // The session id lives in sessionStorage and the server keeps a replay
    // buffer, so a reload resumes rather than starting over.
    const thread = await feed.send('Where is my order, can you track shipping?');
    await feed.waitForTerminal(thread);

    await page.reload();
    await expect(feed.connectionState).toHaveAttribute('data-state', 'open');

    const restored = feed.thread('Where is my order, can you track shipping?');
    await expect(restored).toBeVisible();
    await expect(restored).toHaveAttribute('data-status', 'complete');
    await expect(feed.messages(restored)).toContainText('A-1001');
  });

  test('picks a thread back up when it was started before the stream opened', async ({ feed, page }) => {
    const thread = await feed.send('What is your warranty coverage?');
    await feed.waitForTerminal(thread);

    // A brand new tab with the same session sees the whole history replayed.
    await page.reload();
    await expect(feed.threads).toHaveCount(1);
    await expect(feed.thread('What is your warranty coverage?')).toHaveAttribute(
      'data-status',
      'complete',
    );
  });

  test('reports reconnecting while the stream is unreachable, then recovers', async ({ feed, page }, testInfo) => {
      // This test makes the stream unreachable on purpose, so the browser's own
      // connection error is expected output rather than a defect. Chromium and
      // Firefox word it differently, hence the loose pattern.
      allowConsoleError(
        testInfo,
        /establish a connection|EventSource|ERR_FAILED/,
        'the stream is blocked deliberately',
      );

      // Establish some history first, so recovery has something to replay.
      const before = await feed.send('What is your warranty coverage?');
      await feed.waitForTerminal(before);

      // Block the stream, then reload so a *new* EventSource is created and fails.
      // Neither `page.route` nor `context.setOffline` can tear down a connection
      // that is already open, so simulating the drop means forcing a fresh connect.
      await page.route('**/api/stream*', (route) => route.abort('connectionfailed'));
      await page.reload();

      await expect(feed.connectionState).toHaveAttribute('data-state', 'reconnecting', {
        timeout: 15_000,
      });

      // Restore the route; EventSource retries on the backoff the server
      // advertised via the `retry:` field.
      await page.unroute('**/api/stream*');
      await expect(feed.connectionState).toHaveAttribute('data-state', 'open', { timeout: 20_000 });

      // Recovery replays the history rather than starting from nothing.
      await expect(feed.thread('What is your warranty coverage?')).toHaveAttribute(
        'data-status',
        'complete',
      );

      // And the feed still works afterwards.
      const after = await feed.send('Where is my order, can you track shipping?');
      expect(await feed.waitForTerminal(after)).toBe('complete');
  });

  test('does not duplicate messages when the stream replays', async ({ feed, page }) => {
    // Replay overlap is expected on reconnect; the reducer drops already-applied
    // sequence numbers. A duplicated message here means that guard is gone.
    const thread = await feed.send('What is your warranty coverage?');
    await feed.waitForTerminal(thread);
    const before = await feed.transcript(thread);

    await page.reload();
    await expect(feed.connectionState).toHaveAttribute('data-state', 'open');

    const after = await feed.transcript(feed.thread('What is your warranty coverage?'));
    expect(after).toEqual(before);
  });
});

test.describe('composer behaviour', () => {
  test('sends on Enter and newlines on Shift+Enter', async ({ feed, page }) => {
    await feed.promptInput.fill('What is your warranty coverage?');
    await page.keyboard.press('Shift+Enter');
    // Shift+Enter must not send.
    await expect(feed.threads).toHaveCount(0);

    await feed.promptInput.fill('What is your warranty coverage?');
    await page.keyboard.press('Enter');
    await expect(feed.threads).toHaveCount(1);
  });

  test('clears the input after sending so the next prompt can be typed at once', async ({ feed }) => {
    await feed.send('What is your warranty coverage?');
    await expect(feed.promptInput).toHaveValue('');
  });

  test('never disables the composer while a thread is running', async ({ feed }) => {
    // The premise of the whole UI: you can always start another thread.
    await feed.send('How should we position the product?', 'research');
    await expect(feed.promptInput).toBeEnabled();
    await feed.promptInput.fill('another one');
    await expect(feed.promptInput).toHaveValue('another one');
  });
});
