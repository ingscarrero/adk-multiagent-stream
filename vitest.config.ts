/**
 * Vitest workspace config.
 *
 * Two projects because they need different environments: node for the
 * protocol/agents/server/eval packages, jsdom for the React reducer and hooks.
 * Playwright specs live in `e2e/` and are excluded here — they are a separate
 * runner with a separate lifecycle.
 *
 * Coverage is measured across every source file, not only the ones a test
 * happens to import, so an untested module shows up as 0% rather than
 * vanishing from the report. The three process entrypoints are excluded:
 * they wire a listener, a DOM root and `process.argv` respectively, and are
 * exercised by `pnpm dev`, `pnpm build` and `pnpm eval` instead.
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
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        'apps/server/src/index.ts',
        'apps/web/src/main.tsx',
        'packages/eval/src/cli.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Floors sit three points below the figure measured when they were set
      // (90.79% lines, 81.85% branches on 2026-09-07 — see docs/TESTING.md),
      // so a regression fails CI while an ordinary refactor does not. Raise
      // them when coverage rises.
      thresholds: {
        lines: 87,
        branches: 78,
      },
    },
  },
});
