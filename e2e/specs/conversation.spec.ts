/**
 * Follow-up turns and the human-in-the-loop gate, through the real stack.
 *
 * Both features are a second `runAsync` against a thread's existing ADK
 * session, so both fail in the same way if that plumbing is wrong: the turn
 * runs but lands somewhere the UI does not show it. That is not visible from
 * any single unit layer, which is why these exist.
 */

import { expect, test } from '../fixtures.ts';

const TRACKING = 'Where is my order, can you track shipping?';
const REFUND = 'Refund order A-1001, it arrived damaged';

test.describe('follow-up turns', () => {
  test('offers a composer only once the turn has finished', async ({ feed }) => {
    const thread = await feed.send(TRACKING);

    // While it runs there is nothing to type into -- no disabled box to
    // explain, because a thread that cannot take a message does not offer one.
    await expect(feed.followUpInput(thread)).toHaveCount(0);

    await feed.waitForTerminal(thread);
    await expect(feed.followUpInput(thread)).toBeVisible();
  });

  test('continues the same thread instead of starting another', async ({ feed }) => {
    const thread = await feed.send(TRACKING);
    await feed.waitForTerminal(thread);
    await expect(feed.threads).toHaveCount(1);

    await feed.sendFollowUp(thread, 'When will it arrive?');

    await expect(feed.userMessages(thread)).toHaveText(['When will it arrive?']);
    await expect(feed.threads).toHaveCount(1);
    await expect(feed.messages(thread)).toHaveCount(2);
  });

  test('answers the follow-up from the earlier turn, not from the question alone', async ({
    feed,
  }) => {
    // "When will it arrive?" names no order. An answer mentioning A-1001 can
    // only have come from conversation history.
    const thread = await feed.send(TRACKING);
    await feed.waitForTerminal(thread);
    await feed.sendFollowUp(thread, 'When will it arrive?');

    // Wait for the second message to exist before reading "the last one".
    // Without this the assertion races the turn starting, and `.last()` can
    // still be the first answer -- which also mentions A-1001, so the test
    // would pass for the wrong reason as often as it failed.
    await expect(feed.messages(thread)).toHaveCount(2);
    await expect(feed.messages(thread).nth(1)).toContainText('A-1001');
    await expect(feed.messages(thread).nth(1)).toContainText('still on track');
  });

  test('a second thread is unaffected by a follow-up in the first', async ({ feed }) => {
    const first = await feed.send(TRACKING);
    const second = await feed.send('What is your warranty coverage?');
    await feed.waitForTerminal(first);
    await feed.waitForTerminal(second);

    await feed.sendFollowUp(first, 'When will it arrive?');

    await expect(feed.userMessages(first)).toHaveCount(1);
    await expect(feed.userMessages(second)).toHaveCount(0);
  });
});

test.describe('human-in-the-loop approval', () => {
  test('pauses and asks, showing what would run', async ({ feed }) => {
    const thread = await feed.send(REFUND);

    await feed.expectStatus(thread, 'awaiting_input');
    const approval = feed.approval(thread);
    await expect(approval).toBeVisible();
    // The arguments are the point: "approve requestRefund" is the same
    // sentence whether it is four dollars or four hundred.
    await expect(approval).toContainText('requestRefund');
    await expect(approval).toContainText('129.99');
    await expect(approval).toContainText('A-1001');
  });

  test('applies the refund when approved', async ({ feed }) => {
    const thread = await feed.send(REFUND);
    await feed.expectStatus(thread, 'awaiting_input');

    await feed.decide(thread, true);

    expect(await feed.waitForTerminal(thread)).toBe('complete');
    await expect(feed.messages(thread).last()).toContainText('RF-A-1001');
    // The control goes with the request it answered, so nobody approves twice.
    await expect(feed.approval(thread)).toHaveCount(0);
  });

  test('does not apply the refund when denied, and says so', async ({ feed }) => {
    const thread = await feed.send(REFUND);
    await feed.expectStatus(thread, 'awaiting_input');

    await feed.decide(thread, false);

    expect(await feed.waitForTerminal(thread)).toBe('complete');
    const answer = feed.messages(thread).last();
    await expect(answer).toContainText('not applied the refund');
    await expect(answer).not.toContainText('RF-A-1001');
  });

  test('a paused thread does not block another one', async ({ feed }) => {
    // The pause is per thread. A run waiting on a person must not stop the
    // feed, which is the whole premise of concurrent threads.
    const paused = await feed.send(REFUND);
    await feed.expectStatus(paused, 'awaiting_input');

    const other = await feed.send('What is your warranty coverage?');
    expect(await feed.waitForTerminal(other)).toBe('complete');

    await feed.expectStatus(paused, 'awaiting_input');
  });

  test('a follow-up is offered after the approved turn settles', async ({ feed }) => {
    // The two features meet here: a thread that paused, resumed and finished is
    // an ordinary finished thread and takes a follow-up like any other.
    const thread = await feed.send(REFUND);
    await feed.expectStatus(thread, 'awaiting_input');
    await feed.decide(thread, true);
    await feed.waitForTerminal(thread);

    await expect(feed.followUpInput(thread)).toBeVisible();
  });
});
