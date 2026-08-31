/**
 * The two metrics, named after ADK's.
 *
 * Deliberately simple and fully deterministic. An LLM-as-judge metric would be
 * more expressive and would also make the eval suite non-reproducible, which
 * defeats using it as a regression gate. The place for a judge is a separate,
 * opt-in run against the real model.
 */

import type { ExpectedToolCall } from './types.ts';

/**
 * `tool_trajectory_avg_score` — did the agent take the expected path?
 *
 * Scored per step over the longer of the two sequences, so a trajectory that is
 * correct as far as it goes but stops early is penalised, and so is one that
 * takes extra steps. Order matters: calling the shipping API before looking the
 * order up is a different behaviour, not a reordering.
 *
 * Returns 1 when both sequences are empty — an agent correctly using no tools
 * has a perfect trajectory.
 */
export function toolTrajectoryScore(
  expected: ExpectedToolCall[],
  actual: Array<{ name: string; args: Record<string, unknown> }>,
): number {
  const length = Math.max(expected.length, actual.length);
  if (length === 0) return 1;

  let matched = 0;
  for (let i = 0; i < length; i += 1) {
    const want = expected[i];
    const got = actual[i];
    if (!want || !got) continue;
    if (want.name === got.name && argsMatch(want.args, got.args)) matched += 1;
  }
  return matched / length;
}

/**
 * Subset comparison: every expected key must be present and equal.
 *
 * Extra keys in the actual call are allowed on purpose — a tool gaining an
 * optional parameter should not fail an eval that never cared about it.
 */
function argsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
  );
}

/**
 * `response_match_score` — how close is the answer to the reference?
 *
 * ROUGE-1 F1 over unigrams: the harmonic mean of how much of the reference the
 * answer covered (recall) and how much of the answer was in the reference
 * (precision). This is the metric ADK uses, and the reason it beats exact
 * match is that a correct answer phrased differently still scores well while a
 * confidently wrong one does not.
 */
export function responseMatchScore(expected: string, actual: string): number {
  const wanted = tokenize(expected);
  const got = tokenize(actual);

  if (wanted.length === 0 && got.length === 0) return 1;
  if (wanted.length === 0 || got.length === 0) return 0;

  // Bag semantics: a word repeated twice in the reference can be matched twice.
  const remaining = new Map<string, number>();
  for (const token of wanted) remaining.set(token, (remaining.get(token) ?? 0) + 1);

  let overlap = 0;
  for (const token of got) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(token, count - 1);
    }
  }

  const precision = overlap / got.length;
  const recall = overlap / wanted.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** Lowercase word tokens; punctuation dropped so "2026." matches "2026". */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Case-insensitive substring checks. Returns the phrases that were missing. */
export function findMissingPhrases(required: string[], actual: string): string[] {
  const haystack = actual.toLowerCase();
  return required.filter((phrase) => !haystack.includes(phrase.toLowerCase()));
}
