/**
 * Eval set loading.
 *
 * Parsing through zod rather than casting means a typo in an evalset file is a
 * clear validation error at load time, not an `undefined` that quietly scores
 * every case as passing.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalSetSchema, type EvalSet } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Directory holding the bundled evalsets. */
export const EVALSETS_DIR = resolve(HERE, '..', 'evalsets');

export async function loadEvalSet(path: string): Promise<EvalSet> {
  const raw = await readFile(path, 'utf8');
  return evalSetSchema.parse(JSON.parse(raw));
}
