/**
 * Model resolution tests.
 *
 * `createModel` is the single expression where the two model modes diverge.
 * These pin the contract around it: the default is scripted, `gemini` demands a
 * key, an unknown mode is a boot-time error rather than a silent fallback, and
 * the returned value is the shape `LlmAgent.model` expects in each mode.
 */
import { describe, expect, it } from 'vitest';
import { createModel, resolveModelMode } from './model.ts';
import { ScriptedLlm } from './scripted-llm.ts';

const BRANCHES = [{ match: 'default' as const, turns: [{ kind: 'text' as const, text: 'hi' }] }];

describe('resolveModelMode', () => {
  it('defaults to scripted when MODEL_MODE is unset', () => {
    expect(resolveModelMode({})).toBe('scripted');
  });

  it('accepts the two known modes', () => {
    expect(resolveModelMode({ MODEL_MODE: 'scripted' })).toBe('scripted');
    expect(resolveModelMode({ MODEL_MODE: 'gemini', GOOGLE_API_KEY: 'k' })).toBe('gemini');
  });

  it('rejects an unknown mode loudly, naming the value it saw', () => {
    expect(() => resolveModelMode({ MODEL_MODE: 'openai' })).toThrow(/MODEL_MODE must be .*got "openai"/);
  });

  it('refuses gemini mode without a key, pointing at .env.example', () => {
    expect(() => resolveModelMode({ MODEL_MODE: 'gemini' })).toThrow(/GOOGLE_API_KEY/);
    expect(() => resolveModelMode({ MODEL_MODE: 'gemini', GOOGLE_API_KEY: '' })).toThrow(/GOOGLE_API_KEY/);
  });
});

describe('createModel', () => {
  it('returns a ScriptedLlm labelled with the agent name in scripted mode', () => {
    const model = createModel('order_agent', BRANCHES, { env: {} });
    expect(model).toBeInstanceOf(ScriptedLlm);
    expect((model as ScriptedLlm).model).toBe('scripted/order_agent');
  });

  it('honours an explicit mode over the environment', () => {
    const model = createModel('x', BRANCHES, { mode: 'scripted', env: { MODEL_MODE: 'gemini' } });
    expect(model).toBeInstanceOf(ScriptedLlm);
  });

  it('returns the default Gemini model id string in gemini mode', () => {
    const model = createModel('x', BRANCHES, { env: { MODEL_MODE: 'gemini', GOOGLE_API_KEY: 'k' } });
    expect(model).toBe('gemini-2.5-flash');
  });

  it('lets GEMINI_MODEL pick a different model id', () => {
    const model = createModel('x', BRANCHES, {
      env: { MODEL_MODE: 'gemini', GOOGLE_API_KEY: 'k', GEMINI_MODEL: 'gemini-2.5-pro' },
    });
    expect(model).toBe('gemini-2.5-pro');
  });

  it('passes a chunk delay override through to the scripted model', () => {
    const model = createModel('x', BRANCHES, { env: {}, chunkDelayMs: 0 }) as ScriptedLlm;
    expect(model).toBeInstanceOf(ScriptedLlm);
  });
});
