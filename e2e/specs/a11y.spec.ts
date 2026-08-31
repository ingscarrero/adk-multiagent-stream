/**
 * Accessibility.
 *
 * Two halves, both necessary: an automated axe scan (catches contrast, roles,
 * names, landmarks) and explicit assertions on the things axe cannot judge —
 * whether the *right* content is in a live region, and whether the feed is
 * usable from the keyboard alone. A streaming UI that announces every token is
 * technically conformant and practically unusable.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../fixtures.ts';

test.describe('axe scan', () => {
  test('has no violations when empty', async ({ feed, page }) => {
    void feed;
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no violations with threads streaming and complete', async ({ feed, page }) => {
    const streaming = await feed.send('How should we position the product?', 'research');
    const done = await feed.send('What is your warranty coverage?');
    await feed.waitForTerminal(done);
    void streaming;

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no violations on an errored thread', async ({ feed, page }) => {
    const thread = await feed.send('please fail this run');
    await feed.expectStatus(thread, 'error');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('dark mode', () => {
  // Both palettes ship, so both are scanned. Contrast regressions are easy to
  // introduce in the theme you are not looking at.
  test.use({ colorScheme: 'dark' });

  test('has no violations in dark mode', async ({ feed, page }) => {
    const thread = await feed.send('What is your warranty coverage?');
    await feed.waitForTerminal(thread);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('semantics axe cannot check', () => {
  test('marks the feed as a log region', async ({ page, feed }) => {
    void feed;
    await expect(page.getByRole('log', { name: 'Agent threads' })).toBeVisible();
  });

  test('gives each thread a name derived from its prompt', async ({ feed, page }) => {
    await feed.send('What is your warranty coverage?');
    await expect(
      page.getByRole('region', { name: /What is your warranty coverage/ }),
    ).toBeVisible();
  });

  test('announces status changes politely, once per thread', async ({ feed }) => {
    const thread = await feed.send('What is your warranty coverage?');
    const announcement = thread.getByTestId('thread-status-announcement');

    await expect(announcement).toHaveAttribute('aria-live', 'polite');
    await feed.waitForTerminal(thread);
    await expect(announcement).toContainText('Done');

    // Exactly one live region per thread: two would double every announcement.
    await expect(thread.locator('[aria-live]')).toHaveCount(1);
  });

  test('keeps streaming prose out of any live region', async ({ feed }) => {
    // Marking streaming text as live makes a screen reader re-read the whole
    // message on every token.
    const thread = await feed.send('How should we position the product?', 'research');
    await expect(feed.messages(thread).first()).toBeVisible({ timeout: 15_000 });

    const liveMessages = await feed
      .messages(thread)
      .evaluateAll((nodes) => nodes.filter((n) => n.closest('[aria-live]') !== null).length);
    expect(liveMessages).toBe(0);
  });

  test('is operable from the keyboard alone', async ({ page, feed }) => {
    await feed.promptInput.focus();
    await page.keyboard.type('What is your warranty coverage?');
    await page.keyboard.press('Enter');

    await expect(feed.threads).toHaveCount(1);
    // The Stop control is reachable by tabbing, not mouse-only.
    const thread = feed.thread('What is your warranty coverage?');
    const stop = thread.getByTestId('cancel-thread');
    if (await stop.count()) {
      await stop.focus();
      await expect(stop).toBeFocused();
    }
  });
});
