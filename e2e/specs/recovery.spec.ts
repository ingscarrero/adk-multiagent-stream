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
  test('a reload restores both threads whole, including the one the buffer forgot', async ({
    feed,
    page,
  }) => {
    await overflowBuffer(feed);

    await page.reload();
    await expect(feed.connectionState).toHaveAttribute('data-state', 'open');
    await expect(feed.threads).toHaveCount(2);

    // The recent thread is intact. This is the case that regressed twice: the
    // snapshot watermark once discarded the replay that would have restored it.
    const recent = feed.thread(WARRANTY);
    await expect(feed.messages(recent)).toContainText('warranty');

    // And so is the older one, whose events rolled out of the replay window
    // entirely. That is the whole of L7: the window is the *stream's* property,
    // and the transcript does not share it.
    //
    // This assertion is the inverse of what it used to be. The old version
    // asserted the thread admitted its history was gone -- honest at the time,
    // and exactly the symptom that made L16 worth closing.
    const older = feed.thread(ORDER);
    await expect(feed.messages(older)).toContainText('A-1001');
    await expect(feed.truncation(older)).toHaveCount(0);
    await expect(feed.truncation(recent)).toHaveCount(0);
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

    // `lossy 0` is the assertion that matters, and it is the one that changed
    // meaning. It used to mean "nothing was discarded that we could have kept";
    // now nothing is unrecoverable at all, because the store answered first.
    await expect(feed.stat('lossy')).toHaveText('lossy 0');

    // Redundant drops are now *expected*, which is the inverse of the note that
    // used to be here. Threads are hydrated from the transcript before the
    // stream replays, so the replay is largely re-delivering what the store
    // already supplied -- a healthy overlap rather than a loss.
    await expect(feed.threads).toHaveCount(2);
    await expect(feed.stat('redundant')).toHaveText(/^redundant [1-9]\d*$/);

    // And nothing in that replay was new. Hydration does not count as applied
    // (it bypasses the gates), and both threads had finished before the
    // reload, so every replayed frame is at or below the hydrated watermark.
    // Were hydration to stop working, the replay would be applied normally and
    // this counter would climb -- with the store's contribution invisible.
    await expect(feed.stat('applied')).toHaveText('applied 0');
  });
});
