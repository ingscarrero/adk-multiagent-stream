/**
 * `@feed/eval` — an ADK-style evaluation harness for TypeScript.
 *
 * ADK ships evaluation tooling in Python only; this is the equivalent for the
 * JS agents in this repo, using the same metric names so the numbers are
 * comparable to anything you have read in the ADK docs.
 *
 * @see docs/TESTING.md for how this fits alongside the unit and e2e suites.
 */
export * from './metrics.ts';
export * from './runner.ts';
export * from './types.ts';
export { loadEvalSet } from './load.ts';
