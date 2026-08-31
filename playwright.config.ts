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
    // Firefox and WebKit are wired up but skipped by default to keep the local
    // loop fast; enable with `--project=firefox`. `EventSource` behaviour
    // differs subtly between engines, so it is worth running before shipping.
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

  webServer: [
    {
      command: 'pnpm --filter @feed/server start:test',
      port: 3001,
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
