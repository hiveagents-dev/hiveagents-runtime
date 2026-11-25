import { describe, expect, it } from 'vitest';

import { diffTurnUsage, parseCumulativeUsage } from '../../src/adapters/claude-control/usage.js';

describe('claude control usage', () => {
  it('parses the mixed-convention result envelope like exec does', () => {
    const usage = parseCumulativeUsage({
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
      total_cost_usd: 0.1,
    });
    expect(usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cachedInputTokens: 2,
      reportedCostUsd: 0.1,
      costMeaning: 'api-equivalent',
    });
  });

  it('does not invent an api-equivalent cost when the SDK reports none', () => {
    const usage = parseCumulativeUsage({
      modelUsage: { 'claude-sonnet-5': { inputTokens: 4, outputTokens: 1 } },
    });
    expect(usage?.costMeaning).toBe('unavailable');
    expect(usage?.reportedCostUsd).toBeUndefined();
  });

  it('returns the cumulative usage untouched for the first turn', () => {
    const current = parseCumulativeUsage({
      modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } },
      total_cost_usd: 0.01,
    });
    expect(diffTurnUsage(undefined, current)).toEqual(current);
  });

  it('diffs cumulative totals into per-turn usage, dropping idle models', () => {
    const first = parseCumulativeUsage({
      modelUsage: {
        'claude-sonnet-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.01 },
        'claude-haiku-4-5': { inputTokens: 7, outputTokens: 2 },
      },
      total_cost_usd: 0.01,
    });
    const second = parseCumulativeUsage({
      modelUsage: {
        'claude-sonnet-5': { inputTokens: 25, outputTokens: 9, costUSD: 0.03 },
        'claude-haiku-4-5': { inputTokens: 7, outputTokens: 2 },
      },
      total_cost_usd: 0.03,
    });
    const diff = diffTurnUsage(first, second);
    expect(diff?.inputTokens).toBe(15);
    expect(diff?.outputTokens).toBe(4);
    expect(diff?.reportedCostUsd).toBeCloseTo(0.02);
    expect(diff?.costMeaning).toBe('api-equivalent');
    expect(diff?.perModel).toEqual({
      'claude-sonnet-5': { inputTokens: 15, outputTokens: 4, reportedCostUsd: expect.closeTo(0.02) },
    });
  });

  it('keeps a model that first appears in the current turn', () => {
    const first = parseCumulativeUsage({
      modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } },
    });
    const second = parseCumulativeUsage({
      modelUsage: {
        'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 },
        'claude-haiku-4-5': { inputTokens: 3, outputTokens: 1 },
      },
    });
    const diff = diffTurnUsage(first, second);
    expect(diff?.perModel).toEqual({
      'claude-haiku-4-5': { inputTokens: 3, outputTokens: 1 },
    });
  });
});
