/**
 * Vitest workspace config.
 *
 * Two projects because they need different environments: node for the
 * protocol/agents/server/eval packages, jsdom for the React reducer and hooks.
 * Playwright specs live in `e2e/` and are excluded here — they are a separate
 * runner with a separate lifecycle.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/**/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['apps/web/vitest.setup.ts'],
        },
      },
    ],
  },
});
