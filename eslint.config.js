/**
 * ESLint flat config.
 *
 * Type-aware linting is switched on deliberately: the rules that actually catch
 * bugs in async streaming code (`no-floating-promises`, `no-misused-promises`,
 * `await-thenable`) all need type information. A forgotten `await` on a
 * cancellation or a publish is exactly the class of defect that shows up as an
 * intermittent test failure days later.
 */

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/coverage/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files (vitest, playwright, eslint itself) belong to no
          // package tsconfig. Without this they fail to parse and the lint run
          // reports errors that have nothing to do with the code.
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused args are fine when prefixed with `_`; the pattern documents that
      // the parameter exists to satisfy a signature.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The point of type-aware linting in an async codebase.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `unknown` is preferred over `any`, but tool results and JSON payloads
      // are genuinely unknown, so this is a warning rather than an error.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },

  {
    // This config file and any other plain JS is not part of a TS project;
    // running type-aware rules on it produces only noise about its own imports.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  {
    // Tests assert on partially-typed fixtures and deliberately malformed
    // input; requiring full type safety there produces noise, not safety.
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
