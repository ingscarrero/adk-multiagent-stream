/**
 * Web test setup.
 *
 * Adds jest-dom matchers and unmounts React trees between tests. The explicit
 * `cleanup` matters: Testing Library only auto-registers it when Vitest runs
 * with `globals: true`, and this project does not — without it, every render
 * accumulates in the same document and `getBy*` starts failing with "multiple
 * elements found".
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
