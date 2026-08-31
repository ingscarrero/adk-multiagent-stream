/**
 * Model resolution: deterministic by default, real Gemini on request.
 *
 * `MODEL_MODE=scripted` (the default) returns a {@link ScriptedLlm} per agent.
 * `MODEL_MODE=gemini` returns a model id string, which ADK resolves through its
 * own registry to a `GoogleLlm` backed by `GOOGLE_API_KEY`.
 *
 * Returning `string | BaseLlm` works because `LlmAgent`'s `model` field accepts
 * either — so the two modes differ in exactly one expression and nothing
 * downstream has to branch.
 */

import type { BaseLlm } from '@google/adk';
import { ScriptedLlm, type ScriptBranch } from './scripted-llm.ts';

export type ModelMode = 'scripted' | 'gemini';

export function resolveModelMode(env: NodeJS.ProcessEnv = process.env): ModelMode {
  const mode = env['MODEL_MODE'] ?? 'scripted';
  if (mode !== 'scripted' && mode !== 'gemini') {
    throw new Error(`MODEL_MODE must be "scripted" or "gemini", got "${mode}".`);
  }
  if (mode === 'gemini' && !env['GOOGLE_API_KEY']) {
    throw new Error('MODEL_MODE=gemini requires GOOGLE_API_KEY. See .env.example.');
  }
  return mode;
}

export interface ModelFactoryOptions {
  mode?: ModelMode;
  env?: NodeJS.ProcessEnv;
  /** Overrides the scripted chunk delay. Tests pass 0; the app leaves it default. */
  chunkDelayMs?: number;
}

/**
 * Builds the `model` value for one agent.
 *
 * @param name Agent name, used only to label the scripted model for debugging.
 * @param branches The agent's script, ignored entirely in gemini mode.
 */
export function createModel(
  name: string,
  branches: ScriptBranch[],
  options: ModelFactoryOptions = {},
): string | BaseLlm {
  const env = options.env ?? process.env;
  const mode = options.mode ?? resolveModelMode(env);

  if (mode === 'gemini') {
    return env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
  }

  return new ScriptedLlm({
    model: `scripted/${name}`,
    branches,
    ...(options.chunkDelayMs !== undefined ? { chunkDelayMs: options.chunkDelayMs } : {}),
  });
}
