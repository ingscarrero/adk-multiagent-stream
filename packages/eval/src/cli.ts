#!/usr/bin/env node
/**
 * `pnpm eval` — run an eval set and print a report.
 *
 * Exits non-zero when any case fails, so it works as a CI gate without any
 * extra wrapper.
 *
 * Usage:
 *   pnpm eval                          run the bundled support evalset
 *   pnpm eval --set path/to/x.json     run a specific set
 *   pnpm eval --filter warranty        run only cases whose id matches
 *   pnpm eval --json                   machine-readable output
 */

import { resolve } from 'node:path';
import { loadEvalSet, EVALSETS_DIR } from './load.ts';
import { runEvalSet } from './runner.ts';
import type { EvalCaseResult } from './types.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const asJson = process.argv.includes('--json');
const setPath = resolve(arg('set') ?? `${EVALSETS_DIR}/support.evalset.json`);
const filter = arg('filter');

const set = await loadEvalSet(setPath);

const printCase = (result: EvalCaseResult) => {
  const mark = result.passed ? '✓' : '✗';
  console.log(
    `  ${mark} ${result.id.padEnd(28)} traj ${result.scores.toolTrajectory.toFixed(2)}  ` +
      `resp ${result.scores.responseMatch.toFixed(2)}  ${result.durationMs}ms`,
  );
  for (const failure of result.failures) console.log(`      ${failure}`);
};

if (!asJson) {
  console.log(`\n${set.name} — ${set.cases.length} cases`);
  console.log(
    `thresholds: trajectory >= ${set.thresholds.toolTrajectory}, response >= ${set.thresholds.responseMatch}\n`,
  );
}

const result = await runEvalSet(set, {
  ...(filter ? { filter } : {}),
  ...(asJson ? {} : { onCase: printCase }),
});

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const { summary } = result;
  console.log(
    `\n${summary.passedCount}/${summary.total} passed  ` +
      `(avg trajectory ${summary.avgToolTrajectory.toFixed(2)}, ` +
      `avg response ${summary.avgResponseMatch.toFixed(2)})\n`,
  );
}

process.exit(result.passed ? 0 : 1);
