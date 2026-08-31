/**
 * Page object for the feed.
 *
 * The rule this file enforces: no spec ever touches a selector. Selectors
 * change when the markup changes; the vocabulary a test speaks in
 * ("the thread whose prompt is X", "its status") should not.
 *
 * Every accessor returns a `Locator` rather than a resolved value, so specs
 * keep Playwright's auto-waiting and web-first assertions. A helper that
 * returned a string would force `waitForTimeout` back into the suite, which is
 * where streaming tests go to become flaky.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import type { ThreadStatus } from '@feed/protocol';

export class FeedPage {
  constructor(private readonly page: Page) {}

  async goto(options: { debug?: boolean } = {}): Promise<void> {
    await this.page.goto(options.debug ? '/?debug' : '/');
    // The feed is only meaningful once the stream is live; waiting here means
    // no spec has to think about the connection handshake.
    await expect(this.connectionState).toHaveAttribute('data-state', 'open');
  }

  get connectionState(): Locator {
    return this.page.getByTestId('connection-state');
  }

  get activeCount(): Locator {
    return this.page.getByTestId('active-count');
  }

  get threads(): Locator {
    return this.page.getByTestId('thread');
  }

  get promptInput(): Locator {
    return this.page.getByTestId('prompt-input');
  }

  /** Sends a prompt through the composer, using the given agent. */
  async send(prompt: string, agent: 'router' | 'research' = 'router'): Promise<Locator> {
    await this.page.getByTestId('agent-select').selectOption(agent);
    await this.promptInput.fill(prompt);
    await this.page.getByTestId('send-button').click();
    return this.thread(prompt);
  }

  /** Clicks one of the canned suggestions, which carry their own agent. */
  async sendSuggestion(text: string): Promise<Locator> {
    await this.page.getByTestId('suggestion').filter({ hasText: text }).click();
    return this.thread(text);
  }

  /** The thread whose prompt matches, identified the way a user would identify it. */
  thread(prompt: string): Locator {
    return this.threads.filter({ has: this.page.getByTestId('thread-prompt').filter({ hasText: prompt }) });
  }

  status(thread: Locator): Locator {
    return thread.getByTestId('status-chip');
  }

  messages(thread: Locator): Locator {
    return thread.getByTestId('agent-message');
  }

  toolSteps(thread: Locator): Locator {
    return thread.getByTestId('tool-step');
  }

  /** Waits for a thread to reach a specific status. */
  async expectStatus(thread: Locator, status: ThreadStatus, timeout = 15_000): Promise<void> {
    await expect(thread).toHaveAttribute('data-status', status, { timeout });
  }

  /** Waits for a thread to reach any terminal status, and returns which one. */
  async waitForTerminal(thread: Locator, timeout = 20_000): Promise<string> {
    await expect(async () => {
      const status = await thread.getAttribute('data-status');
      expect(['complete', 'error', 'cancelled']).toContain(status);
    }).toPass({ timeout });
    return (await thread.getAttribute('data-status')) ?? '';
  }

  /** Counter readout, present only when the page was opened with `?debug`. */
  stat(name: 'applied' | 'buffered' | 'redundant' | 'lossy' | 'resyncs'): Locator {
    return this.page.getByTestId(`stat-${name}`);
  }

  /** The truncation notice on a thread, if it has one. `data-extent` says how much was lost. */
  truncation(thread: Locator): Locator {
    return thread.getByTestId('thread-truncated');
  }

  /**
   * Clicks Stop.
   *
   * Both waits are bounded, and for the same reason: Stop is unmounted the
   * instant a thread reaches a terminal status. A thread that finishes first
   * should fail as "it was already done", not as a detached-element timeout
   * that eats the whole 30s test budget and says nothing about the cause.
   *
   * The check and the click are separately bounded because they fail for
   * different reasons -- the first means Stop never appeared, the second means
   * it appeared and then went away mid-click. The second is the race that
   * `SCRIPTED_CHUNK_DELAY_MS` in playwright.config.ts exists to widen.
   */
  async cancel(thread: Locator): Promise<void> {
    const stop = thread.getByTestId('cancel-thread');
    await expect(stop, 'thread finished before it could be cancelled').toBeVisible({
      timeout: 5_000,
    });
    await stop.click({ timeout: 5_000 });
  }

  /** Concatenated text of every message in a thread, in render order. */
  async transcript(thread: Locator): Promise<string[]> {
    return this.messages(thread).getByTestId('message-text').allTextContents();
  }
}
