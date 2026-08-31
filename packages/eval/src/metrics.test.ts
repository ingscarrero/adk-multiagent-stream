/**
 * Metric tests.
 *
 * A scoring function that is subtly wrong is worse than no eval at all: it
 * reports green while the agent regresses. These pin down the exact behaviour
 * at the boundaries — empty inputs, partial matches, extra steps, reordering.
 */
import { describe, expect, it } from 'vitest';
import { findMissingPhrases, responseMatchScore, toolTrajectoryScore } from './metrics.ts';

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe('toolTrajectoryScore', () => {
  it('scores an exact match as 1', () => {
    expect(toolTrajectoryScore([call('a'), call('b')], [call('a'), call('b')])).toBe(1);
  });

  it('scores no tools expected and none taken as 1', () => {
    // An agent that correctly answers without tools has a perfect trajectory.
    expect(toolTrajectoryScore([], [])).toBe(1);
  });

  it('penalises a missing step', () => {
    expect(toolTrajectoryScore([call('a'), call('b')], [call('a')])).toBe(0.5);
  });

  it('penalises an extra step', () => {
    expect(toolTrajectoryScore([call('a')], [call('a'), call('b')])).toBe(0.5);
  });

  it('treats reordering as wrong, because order is behaviour', () => {
    // Checking shipping before looking the order up is a different agent.
    expect(toolTrajectoryScore([call('a'), call('b')], [call('b'), call('a')])).toBe(0);
  });

  it('compares arguments as a subset, tolerating new optional parameters', () => {
    const expected = [call('lookupOrder', { orderId: 'A-1' })];
    const actual = [call('lookupOrder', { orderId: 'A-1', trace: true })];
    expect(toolTrajectoryScore(expected, actual)).toBe(1);
  });

  it('fails when a required argument differs', () => {
    expect(
      toolTrajectoryScore([call('lookupOrder', { orderId: 'A-1' })], [call('lookupOrder', { orderId: 'A-2' })]),
    ).toBe(0);
  });

  it('scores tools taken when none were expected as 0', () => {
    expect(toolTrajectoryScore([], [call('a')])).toBe(0);
  });
});

describe('responseMatchScore', () => {
  it('scores identical text as 1', () => {
    expect(responseMatchScore('the order has shipped', 'the order has shipped')).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(responseMatchScore('Order A-1001 shipped.', 'order a 1001 shipped')).toBe(1);
  });

  it('scores unrelated text as 0', () => {
    expect(responseMatchScore('order shipped', 'warranty covers defects')).toBe(0);
  });

  it('rewards partial overlap between 0 and 1', () => {
    const score = responseMatchScore('the order has shipped today', 'the order shipped');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('penalises padding, because recall alone would not', () => {
    // A verbose answer that buries the reference should score below a concise
    // one. This is why the metric is F1 rather than recall.
    const concise = responseMatchScore('order shipped', 'order shipped');
    const padded = responseMatchScore('order shipped', `order shipped ${'filler '.repeat(20)}`);
    expect(padded).toBeLessThan(concise);
  });

  it('scores an empty answer against a reference as 0', () => {
    expect(responseMatchScore('order shipped', '')).toBe(0);
  });

  it('scores two empty strings as 1', () => {
    expect(responseMatchScore('', '')).toBe(1);
  });
});

describe('findMissingPhrases', () => {
  it('returns nothing when every phrase is present', () => {
    expect(findMissingPhrases(['A-1001', 'shipped'], 'Order A-1001 has shipped')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(findMissingPhrases(['a-1001'], 'Order A-1001')).toEqual([]);
  });

  it('names exactly the phrases that are missing', () => {
    expect(findMissingPhrases(['A-1001', 'delivered'], 'Order A-1001 has shipped')).toEqual([
      'delivered',
    ]);
  });
});
