/**
 * Runs an eval set against the real ADK agents.
 *
 * Uses `InMemoryRunner` directly rather than going through the HTTP server:
 * evals grade the *agent*, not the transport. If a case fails you want to know
 * the agent regressed, not spend an hour discovering the SSE buffer was full.
 */

import { InMemoryRunner, StreamingMode, type Event } from '@google/adk';
import { createAgent } from '@feed/agents';
import { findMissingPhrases, responseMatchScore, toolTrajectoryScore } from './metrics.ts';
import type { EvalCase, EvalCaseResult, EvalRunResult, EvalSet } from './types.ts';

/** Framework calls are excluded from the trajectory: they are ADK's, not the agent's. */
const FRAMEWORK_CALLS = new Set([
  'transfer_to_agent',
  'adk_request_confirmation',
  'adk_request_credential',
  'adk_request_input',
]);

const DEFAULT_THRESHOLDS: EvalSet['thresholds'] = { toolTrajectory: 1, responseMatch: 0.6 };

export interface RunEvalOptions {
  /** Restricts the run to case ids matching this substring. */
  filter?: string;
  /** Called after each case, for progress output. */
  onCase?: (result: EvalCaseResult) => void;
}

export async function runEvalCase(
  evalCase: EvalCase,
  thresholds: EvalSet['thresholds'] = DEFAULT_THRESHOLDS,
): Promise<EvalCaseResult> {
  const started = Date.now();

  const runner = new InMemoryRunner({
    // Zero delay: evals grade content, and streaming timing is irrelevant here.
    agent: createAgent(evalCase.agent, { mode: 'scripted', chunkDelayMs: 0 }),
    appName: 'eval',
  });

  const events: Event[] = [];
  for await (const event of runner.runEphemeral({
    userId: 'eval',
    newMessage: { role: 'user', parts: [{ text: evalCase.query }] },
    runConfig: { streamingMode: StreamingMode.SSE, maxLlmCalls: 20 },
  })) {
    events.push(event);
  }

  const actualCalls = events
    .flatMap((event) => event.content?.parts ?? [])
    .flatMap((part) => (part.functionCall ? [part.functionCall] : []))
    .filter((call) => !FRAMEWORK_CALLS.has(call.name ?? ''))
    .map((call) => ({ name: call.name ?? '', args: call.args ?? {} }));

  // Only final (non-partial) events carry settled text; including partials
  // would count every token several times over.
  const actualResponse = events
    .filter((event) => !event.partial)
    .flatMap((event) => event.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return grade(evalCase, actualCalls, actualResponse, Date.now() - started, thresholds);
}

/**
 * Scoring, split out from execution so it can be unit-tested against fixed
 * inputs without running an agent.
 */
export function grade(
  evalCase: EvalCase,
  actualCalls: Array<{ name: string; args: Record<string, unknown> }>,
  actualResponse: string,
  durationMs: number,
  thresholds: EvalSet['thresholds'] = DEFAULT_THRESHOLDS,
): EvalCaseResult {
  const trajectory = toolTrajectoryScore(evalCase.expectedToolTrajectory, actualCalls);
  const responseMatch = evalCase.expectedResponse
    ? responseMatchScore(evalCase.expectedResponse, actualResponse)
    : 1;
  const missing = findMissingPhrases(evalCase.mustContain, actualResponse);

  const failures: string[] = [];
  if (trajectory < thresholds.toolTrajectory) {
    failures.push(
      `tool trajectory ${trajectory.toFixed(2)} < ${thresholds.toolTrajectory}: ` +
        `expected [${evalCase.expectedToolTrajectory.map((c) => c.name).join(', ')}], ` +
        `got [${actualCalls.map((c) => c.name).join(', ')}]`,
    );
  }
  if (responseMatch < thresholds.responseMatch) {
    failures.push(`response match ${responseMatch.toFixed(2)} < ${thresholds.responseMatch}`);
  }
  if (missing.length > 0) {
    failures.push(`answer is missing: ${missing.join(', ')}`);
  }

  return {
    id: evalCase.id,
    query: evalCase.query,
    agent: evalCase.agent,
    passed: failures.length === 0,
    scores: { toolTrajectory: trajectory, responseMatch },
    actualToolTrajectory: actualCalls.map((call) => call.name),
    actualResponse,
    failures,
    durationMs,
  };
}

export async function runEvalSet(set: EvalSet, options: RunEvalOptions = {}): Promise<EvalRunResult> {
  const selected = options.filter
    ? set.cases.filter((evalCase) => evalCase.id.includes(options.filter!))
    : set.cases;

  const results: EvalCaseResult[] = [];
  for (const evalCase of selected) {
    // Sequential on purpose: a failing eval should be readable in order, and
    // each run is milliseconds against the scripted model.
    const result = await runEvalCase(evalCase, set.thresholds);
    results.push(result);
    options.onCase?.(result);
  }

  const passedCount = results.filter((result) => result.passed).length;
  const average = (pick: (r: EvalCaseResult) => number) =>
    results.length === 0 ? 0 : results.reduce((sum, r) => sum + pick(r), 0) / results.length;

  return {
    set: set.name,
    passed: passedCount === results.length,
    cases: results,
    summary: {
      total: results.length,
      passedCount,
      avgToolTrajectory: average((r) => r.scores.toolTrajectory),
      avgResponseMatch: average((r) => r.scores.responseMatch),
    },
  };
}
