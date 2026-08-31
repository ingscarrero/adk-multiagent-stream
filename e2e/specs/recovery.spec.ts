/**
 * Replay-buffer overrun and resync, driven through a real browser.
 *
 * This file exists because three separate recovery bugs shipped with the rest
 * of the suite green. Each was found by hand, in a browser, after the unit and
 * integration tests had passed:
 *
 * 1. the client never listened for `resync` at all;
 * 2. a fresh connect -- a plain reload -- took a branch that sent no notice;
 * 3. adopting the snapshot's `lastSeq` discarded the very replay that followed.
 *
 * Every one lived in the seam between layers that were individually correct.
 * The only thing that catches that is the whole stack, in a browser, against a
 * buffer small enough to actually overflow.
 *
 * Runs under the `recovery` project: a second server whose replay buffer holds
 * 40 events, which is less than two threads' worth. On the default 500-event
 * buffer this scenario needs about twenty-five prompts, which is why it went
 * untested for so long.
 */
import { expect, test } from '../fixtures.ts';
import { FeedPage } from '../pages/FeedPage.ts';

const ORDER = 'Where is my order, can you track shipping?';
const WARRANTY = 'What is your warranty coverage?';

/** Two threads (~23 events each) overrun the 40-event buffer, oldest first. */
async function overflowBuffer(feed: FeedPage) {
  const first = await feed.send(ORDER);
  await feed.waitForTerminal(first);
  const second = await feed.send(WARRANTY);
  await feed.waitForTerminal(second);
}

test.describe('replay-buffer overrun', () => {
  test('a reload keeps what the buffer still holds, and admits the rest is gone', async ({
    feed,
    page,
  }) => {
    await overflowBuffer(feed);

    await page.reload();
    await expect(feed.connectionState).toHaveAttribute('data-state', 'open');
    await expect(feed.threads).toHaveCount(2);

    // The recent thread is intact -- its events are still in the replay. This
    // is the case that regressed: the snapshot watermark discarded them all and
    // the thread rendered empty.
    const recent = feed.thread(WARRANTY);
    await expect(feed.messages(recent)).toContainText('warranty');
    await expect(feed.truncation(recent)).toHaveCount(0);

    // The older thread lost its beginning and says so, rather than presenting a
    // partial transcript as though it were whole.
    await expect(feed.truncation(feed.thread(ORDER))).toBeVisible();
  });

  test('recovery settles after one resync instead of looping', async ({ page }) => {
    // The loop: reconnecting with no resume point made the server report the
    // overrun again immediately, so the stream was torn down over and over.
    const feed = new FeedPage(page);
    await feed.goto({ debug: true });
    await overflowBuffer(feed);

    await page.reload();
    await expect(feed.connectionState).toHaveAttribute('data-state', 'open');
    await expect(feed.stat('resyncs')).toHaveText('resyncs 1');

    // Hold still long enough that a runaway loop would show itself.
    await page.waitForTimeout(2000);
    await expect(feed.stat('resyncs')).toHaveText('resyncs 1');
  });

  test('a thread sent after recovery streams normally', async ({ feed, page }) => {
    // The loop's visible symptom had nothing to do with reconnection: brand new
    // threads arrived empty, because the stream kept being torn down mid-flight.
    await overflowBuffer(feed);

    await page.reload();
    await expect(feed.connectionState).toHaveAttribute('data-state', 'open');

    // Let the rebuild settle before counting: threads arrive from the snapshot
    // asynchronously, so reading the count too early races the recovery.
    await expect(feed.threads).toHaveCount(2);

    // Target the newest card rather than matching on prompt text: the recovered
    // feed already contains a thread with this prompt.
    await feed.send(ORDER);
    await expect(feed.threads).toHaveCount(3);
    const fresh = feed.threads.nth(2);

    expect(await feed.waitForTerminal(fresh)).toBe('complete');
    await expect(feed.toolSteps(fresh)).toHaveCount(3);
    await expect(feed.messages(fresh)).toContainText('A-1001');
    await expect(feed.truncation(fresh)).toHaveCount(0);
  });

  test('the counters make the recovery visible', async ({ page }) => {
    // `?debug` exposes what `FeedState.stats` has always tracked. Without it
    // these bugs were invisible in the running app and had to be diagnosed from
    // network frames.
    const feed = new FeedPage(page);
    await feed.goto({ debug: true });
    await overflowBuffer(feed);

    await expect(feed.stat('resyncs')).toHaveText('resyncs 0');
    await page.reload();

    await expect(feed.stat('resyncs')).toHaveText('resyncs 1');
    // The replay actually landed. (Redundant drops are *not* expected here:
    // rebuilt threads resume at whatever the replay delivers first, so nothing
    // arrives that has already been applied.)
    await expect(feed.stat('applied')).not.toHaveText('applied 0');
  });
});
