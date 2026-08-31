/**
 * Eval set schema.
 *
 * ## Why this package exists
 *
 * ADK's evaluation tooling — `AgentEvaluator`, evalset files, the `adk eval`
 * command — ships in **adk-python only**. `@google/adk` (JS) has no equivalent
 * as of v2.0.0. So this is a small, deliberate reimplementation of the same
 * ideas in TypeScript, using the metric names ADK uses so the numbers mean the
 * same thing to anyone who has read the Python docs.
 *
 * The format mirrors ADK's evalset shape closely enough to be recognisable,
 * while dropping the parts (session state fixtures, multi-turn conversations)
 * that this repo does not need.
 */

import { z } from 'zod';

/** One expected tool invocation, name and arguments. */
export const expectedToolCallSchema = z.object({
  name: z.string(),
  /**
   * Expected arguments.
   *
   * Compared as a subset: an actual call matches if it contains at least these
   * keys with these values. Strict equality would make every eval brittle
   * against a new optional parameter, which is a change in the tool, not a
   * regression in the agent.
   */
  args: z.record(z.string(), z.unknown()).default({}),
});

export type ExpectedToolCall = z.infer<typeof expectedToolCallSchema>;

export const evalCaseSchema = z.object({
  id: z.string(),
  /** What the user asks. */
  query: z.string(),
  /** Which agent entrypoint to run it against. */
  agent: z.enum(['router', 'research']).default('router'),
  /**
   * The tool calls the agent is expected to make, in order.
   *
   * This is the trajectory. Two agents can produce the same final answer while
   * one of them looked up the order and the other guessed; only the trajectory
   * tells them apart.
   */
  expectedToolTrajectory: z.array(expectedToolCallSchema).default([]),
  /** A reference answer. Scored by word overlap, not equality. */
  expectedResponse: z.string().optional(),
  /** Substrings the answer must contain. A cheap, unambiguous grounding check. */
  mustContain: z.array(z.string()).default([]),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalSetSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Per-metric pass thresholds, applied to every case in the set. */
  thresholds: z
    .object({
      toolTrajectory: z.number().min(0).max(1).default(1),
      responseMatch: z.number().min(0).max(1).default(0.6),
    })
    .default({ toolTrajectory: 1, responseMatch: 0.6 }),
  cases: z.array(evalCaseSchema).min(1),
});

export type EvalSet = z.infer<typeof evalSetSchema>;

/** The outcome of running one case. */
export interface EvalCaseResult {
  id: string;
  query: string;
  agent: string;
  passed: boolean;
  scores: {
    /** ADK's `tool_trajectory_avg_score`. */
    toolTrajectory: number;
    /** ADK's `response_match_score`. */
    responseMatch: number;
  };
  actualToolTrajectory: string[];
  actualResponse: string;
  /** Human-readable reasons the case failed. Empty when it passed. */
  failures: string[];
  durationMs: number;
}

export interface EvalRunResult {
  set: string;
  passed: boolean;
  cases: EvalCaseResult[];
  summary: {
    total: number;
    passedCount: number;
    avgToolTrajectory: number;
    avgResponseMatch: number;
  };
}
