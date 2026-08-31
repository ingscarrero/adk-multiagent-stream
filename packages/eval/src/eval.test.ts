/**
 * The eval suite as a regression gate.
 *
 * `pnpm eval` is the tool you reach for while iterating on an agent. This file
 * is the same evalset wired into `pnpm test`, so a change to a prompt, a script,
 * or the agent graph cannot land without the behavioural expectations being
 * re-checked. It is cheap enough to belong in the normal test run: the whole
 * set takes about a second against the scripted model.
 */
import { describe, expect, it } from 'vitest';
import { loadEvalSet, EVALSETS_DIR } from './load.ts';
import { runEvalCase } from './runner.ts';

const set = await loadEvalSet(`${EVALSETS_DIR}/support.evalset.json`);

describe(`evalset: ${set.name}`, () => {
  it.each(set.cases.map((evalCase) => [evalCase.id, evalCase] as const))(
    'case %s meets its thresholds',
    async (_id, evalCase) => {
      const result = await runEvalCase(evalCase, set.thresholds);
      // The failure list is the assertion message: a red eval should say what
      // the agent did differently, not just that a number was too low.
      expect(result.failures, result.failures.join('\n')).toEqual([]);
      expect(result.passed).toBe(true);
    },
  );

  it('holds every case to a full-match tool trajectory', () => {
    // Loosening this threshold would let an agent skip a tool and still pass,
    // which is the exact regression evals exist to catch.
    expect(set.thresholds.toolTrajectory).toBe(1);
  });
});
