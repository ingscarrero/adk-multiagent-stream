/**
 * Shared fixtures.
 *
 * `feed` gives every test a connected page object, so no spec repeats the
 * navigate-and-wait-for-connection dance.
 *
 * `consoleErrors` fails a test if the app logged an error. That catches the
 * class of bug that leaves the UI looking fine while React throws quietly in an
 * effect — exactly what a streaming app is prone to.
 *
 * A test that *intends* to break something declares what it expects with
 * {@link allowConsoleError}, so the guard stays strict everywhere else rather
 * than being weakened globally.
 */

import { test as base, expect, type TestInfo } from '@playwright/test';
import { FeedPage } from './pages/FeedPage.ts';

const ALLOW_ANNOTATION = 'allow-console-error';

/**
 * Declares a console-error pattern this test expects to produce.
 *
 * Call it inside the test body, before the thing that triggers the error.
 * Annotations are used rather than a `test.use` option because they are
 * per-test rather than per-file, and they show up in the HTML report — so a
 * reader can see which tests suppress what, and why.
 */
export function allowConsoleError(testInfo: TestInfo, pattern: RegExp, why: string): void {
  testInfo.annotations.push({ type: ALLOW_ANNOTATION, description: `${pattern.source} — ${why}` });
}

/**
 * Noise from the browser or the dev server, never from the app.
 * Engine wording differs (Chromium says `net::ERR_`, Firefox writes prose),
 * which is why this is a list of patterns rather than one string.
 */
const IGNORED = [/favicon/i, /net::ERR_/i, /\[vite\]/i, /Failed to load resource/i];

export const test = base.extend<{ feed: FeedPage; consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await use(errors);

    const allowed = testInfo.annotations
      .filter((annotation) => annotation.type === ALLOW_ANNOTATION)
      .map((annotation) => new RegExp((annotation.description ?? '').split(' — ')[0] ?? '', 'i'));

    const unexpected = errors.filter(
      (text) => ![...IGNORED, ...allowed].some((pattern) => pattern.test(text)),
    );
    expect(unexpected, `unexpected console errors:\n${unexpected.join('\n')}`).toHaveLength(0);
  },

  feed: async ({ page, consoleErrors }, use) => {
    void consoleErrors; // ensure the listener is attached before navigation
    const feed = new FeedPage(page);
    await feed.goto();
    await use(feed);
  },
});

export { expect };
