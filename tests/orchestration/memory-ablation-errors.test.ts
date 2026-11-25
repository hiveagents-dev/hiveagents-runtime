import { describe, expect, it } from 'vitest';
import { ablationVerdict } from '../../src/orchestration/memory/ablation.js';
import { each, runsOf } from './memory-ablation-fixture.js';

/**
 * Regression tests for the reviewer probe rv2-v1-ablation: pass rates over answered runs let
 * errors concentrated in one condition, fewer than one task's worth of runs, decide the verdict.
 * When error counts differ, the verdict must also hold with every errored run counted as a failure.
 * Five tasks, four repeats: one task's worth is four runs, and 25% is five errored runs.
 */

const rule = { minTasks: 5, maxErrorRate: 0.25 };

describe('ablationVerdict with errors concentrated in one condition (rv2-v1)', () => {
  it('does not report helps when the errored runs of on are what makes it look better', () => {
    // Over answered runs on wins all five tasks (2/3 against 2/4 on three of them); over all runs those three tie.
    expect(ablationVerdict(runsOf({
      on: ['110e', '110e', '110e', '1110', '1110'], off: each(5, '1100'), irrelevant: each(5, '1100'),
    }), rule)).toMatchObject({ verdict: 'inconclusive', reason: 'UNBALANCED_ERRORS' });
  });

  it('does not hide a gain behind errored runs of off either (the symmetric case)', () => {
    // Over answered runs off ties on three tasks (3/3 against 4/4): 2-0, not significant. Over all runs: 5-0.
    expect(ablationVerdict(runsOf({
      on: each(5, '1111'), off: ['111e', '111e', '111e', '1100', '1100'], irrelevant: each(5, '1100'),
    }), rule)).toMatchObject({ verdict: 'inconclusive', reason: 'UNBALANCED_ERRORS' });
  });

  it('keeps the verdict when both readings agree, and when error counts are equal', () => {
    // One errored off run: helps over answered runs and over all runs.
    expect(ablationVerdict(runsOf({
      on: each(5, '1111'), off: [...each(4, '0000'), '000e'], irrelevant: each(5, '0000'),
    }), rule)).toMatchObject({ verdict: 'helps', reason: 'GAIN' });
    // Errors in on that cannot flip the verdict: a loss both ways.
    expect(ablationVerdict(runsOf({
      on: ['0000', '0000', '0000', '00e0', '0e00'], off: each(5, '1111'), irrelevant: each(5, '1111'),
    }), rule)).toMatchObject({ verdict: 'hurts', reason: 'LOSS' });
    // Equal error counts: rates over answered runs only, as before.
    expect(ablationVerdict(runsOf({
      on: [...each(3, '111e'), '1111', '1111'], off: [...each(3, '000e'), '0000', '0000'], irrelevant: [...each(3, '000e'), '0000', '0000'],
    }), rule)).toMatchObject({ verdict: 'helps', reason: 'GAIN' });
  });
});
