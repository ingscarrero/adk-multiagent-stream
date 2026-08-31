/**
 * Playwright configuration.
 *
 * ## Why this suite is not flaky
 *
 * The model is deterministic (`MODEL_MODE=scripted`, the default), so every run
 * produces the same tokens in the same order with the same timing envelope.
 * That is what makes it reasonable to assert on streaming behaviour at all —
 * against a real LLM these tests would be re-runs and hope.
 *
 * Two servers are started: the API on 3001 and Vite on 5173, with Vite proxying
 * `/api` so the browser stays same-origin. `reuseExistingServer` keeps local
 * runs fast when a dev server is already up.
 */
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e/specs',
  // Threads are isolated per browser context (the session id lives in
  // sessionStorage), so files can run fully in parallel without interfering.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:5173',
    // Traces are the difference between "flaky, rerunning" and a diagnosis.
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // Recovery needs a server with a small replay buffer; it has its own project.
      testIgnore: /recovery\.spec\.ts/,
    },
    // Firefox runs by default alongside Chromium: `EventSource` retry behaviour
    // differs between engines, and that difference has already produced a real
    // bug here (Firefox parks a failed stream in CLOSED and never retries). It
    // skips a11y because those axe rules are engine-independent, so running
    // them twice buys wall-clock and nothing else. WebKit is not wired up.
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: /a11y|recovery\.spec\.ts/,
    },
    {
      /**
       * Replay-buffer overrun and resync, in a real browser.
       *
       * Runs against a second server whose replay buffer holds 40 events -- less
       * than two threads' worth -- so an overrun happens after a couple of
       * prompts instead of twenty-five. Reproducing this on the default 500
       * buffer is impractical, which is exactly why three recovery bugs shipped
       * with the rest of the suite green.
       */
      name: 'recovery',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5174' },
      testMatch: /recovery\.spec\.ts/,
    },
  ],

  /**
   * Scripted streaming is slowed for the browser suite only.
   *
   * At the 25ms default a research thread is finished about a second after it
   * starts, and the cancellation specs have to get from "the first message is
   * visible" to "the Stop click landed" inside that window. A loaded CI runner
   * does not, so Stop unmounts mid-click and Playwright reports a detached
   * element thirty seconds later. Slowing the stream widens the window instead
   * of papering over it with a retry.
   *
   * The cost is a couple of seconds across the whole suite; CI wall-clock here
   * is dominated by installing browsers, not by streaming. Unit tests are
   * unaffected -- they never start a server.
   */
  webServer: [
    {
      command: 'pnpm --filter @feed/server start:test',
      port: 3001,
      env: { SCRIPTED_CHUNK_DELAY_MS: '60' },
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @feed/web dev',
      port: 5173,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    // The small-buffer pair, for the `recovery` project.
    {
      command: 'pnpm --filter @feed/server dev:recovery',
      port: 3002,
      env: { SCRIPTED_CHUNK_DELAY_MS: '60' },
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @feed/web dev:recovery',
      port: 5174,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
