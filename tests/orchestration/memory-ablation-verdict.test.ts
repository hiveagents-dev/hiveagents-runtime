import { describe, expect, it } from 'vitest';
import { ablationVerdict } from '../../src/orchestration/memory/ablation.js';
import { each, runsOf } from './memory-ablation-fixture.js';

/**
 * The verdict is a paired test over tasks: per task, the conditions' pass rates are compared, and a
 * one-sided exact sign test over the discordant tasks must reach `alpha` (default 0.05), on top of
 * the one-task margin on the pooled pass rates. A one-task difference alone is no longer an effect.
 */
const rule = { minTasks: 5, maxErrorRate: 0.25 };

describe('ablationVerdict: needs enough tasks and few errors before it says anything', () => {
  it('keeps TOO_FEW_TASKS, TOO_MANY_ERRORS and NO_RUNS', () => {
    expect(ablationVerdict(runsOf({ off: '0000', on: '1111', irrelevant: '0000' }), rule))
      .toMatchObject({ verdict: 'inconclusive', reason: 'TOO_FEW_TASKS' });
    expect(ablationVerdict(runsOf({ off: '00000', on: '111ee', irrelevant: '00000' }), rule))
      .toMatchObject({ verdict: 'inconclusive', reason: 'TOO_MANY_ERRORS' });
    expect(ablationVerdict(runsOf({ off: '00000', irrelevant: '00000' }), rule))
      .toMatchObject({ verdict: 'inconclusive', reason: 'NO_RUNS' });
    expect(ablationVerdict(runsOf({ off: '00000', on: 'eeeee', irrelevant: '00000' }), { ...rule, maxErrorRate: 1 }))
      .toMatchObject({ verdict: 'inconclusive', reason: 'NO_RUNS' });
  });

  it('refuses the aggregate form of before: the paired test needs the runs', () => {
    const legacy = ablationVerdict as unknown as (...args: unknown[]) => unknown;
    expect(() => legacy(5, { off: { runs: 5, passed: 2, errors: 0 } }, rule)).toThrow(TypeError);
    expect(() => legacy(5, { off: { runs: 5, passed: 2, errors: 0 } }, rule)).toThrow(/runs/);
    expect(() => ablationVerdict([{ task: 't1', condition: 'sometimes' as never, passed: true }], rule)).toThrow(TypeError);
  });
});

describe('ablationVerdict: a paired sign test over tasks', () => {
  it('a one-task difference is not significant any more (it was GAIN, LOSS)', () => {
    expect(ablationVerdict(runsOf({ off: '11000', on: '11100', irrelevant: '11000' }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'NOT_SIGNIFICANT' });
    expect(ablationVerdict(runsOf({ off: '11100', on: '11000', irrelevant: '11100' }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'NOT_SIGNIFICANT' });
    // Ten tasks, 6 against 5 with mixed discordance (3 to 2): the old rule said helps.
    expect(ablationVerdict(runsOf({ off: '1111100000', on: '1101011100', irrelevant: '0000000000' }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'NOT_SIGNIFICANT' });
  });

  it('helps when on beats off and irrelevant on every discordant task, at alpha', () => {
    const result = ablationVerdict(runsOf({ off: '00000', on: '11111', irrelevant: '00000' }), rule);
    expect(result).toEqual({
      verdict: 'helps', reason: 'GAIN',
      tests: {
        onVsOff: { better: 5, worse: 0, ties: 0, pBetter: 1 / 32, pWorse: 1 },
        onVsIrrelevant: { better: 5, worse: 0, ties: 0, pBetter: 1 / 32, pWorse: 1 },
      },
    });
  });

  it('is GAIN_NOT_ABOVE_IRRELEVANT when any context of that shape does about as well', () => {
    expect(ablationVerdict(runsOf({ off: '00000', on: '11111', irrelevant: '11110' }), rule))
      .toMatchObject({ verdict: 'inconclusive', reason: 'GAIN_NOT_ABOVE_IRRELEVANT' });
    expect(ablationVerdict(runsOf({ off: '00000', on: '11111', irrelevant: '11111' }), rule))
      .toMatchObject({ verdict: 'inconclusive', reason: 'GAIN_NOT_ABOVE_IRRELEVANT' });
  });

  it('hurts, symmetrically', () => {
    expect(ablationVerdict(runsOf({ off: '11111', on: '00000', irrelevant: '11111' }), rule))
      .toMatchObject({ verdict: 'hurts', reason: 'LOSS', tests: { onVsOff: { better: 0, worse: 5, pWorse: 1 / 32 } } });
    expect(ablationVerdict(runsOf({ off: '11111', on: '01000', irrelevant: '11111' }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'NOT_SIGNIFICANT' });
  });

  it('no difference is WITHIN_ONE_TASK; concordant tasks are left out of the test', () => {
    expect(ablationVerdict(runsOf({ off: '11100', on: '11100', irrelevant: '00000' }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'WITHIN_ONE_TASK', tests: { onVsOff: { better: 0, worse: 0, ties: 5, pBetter: 1 } } });
  });

  it('with repeats, compares per-task pass rates, and still needs the one-task margin', () => {
    // On wins every task by one run in three: significant (5-0) and a third of a task per task, 5/3 tasks in all.
    expect(ablationVerdict(runsOf({ off: each(5, '100'), on: each(5, '110'), irrelevant: each(5, '100') }), rule))
      .toMatchObject({ verdict: 'helps', reason: 'GAIN', tests: { onVsOff: { better: 5, worse: 0 } } });
    // Significant (5-0) but one run in ten per task: half a task in all, under the margin.
    expect(ablationVerdict(runsOf({ off: each(5, '1000000000'), on: each(5, '1100000000'), irrelevant: each(5, '1000000000') }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'WITHIN_ONE_TASK' });
    // The same pooled gain concentrated on two tasks is not significant.
    expect(ablationVerdict(runsOf({ off: each(5, '100'), on: ['111', '111', '110', '100', '100'], irrelevant: each(5, '100') }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'NOT_SIGNIFICANT', tests: { onVsOff: { better: 3, worse: 0, ties: 2, pBetter: 1 / 8 } } });
  });

  it('takes alpha from the rule', () => {
    const runs = runsOf({ off: '00000', on: '11111', irrelevant: '00000' });
    expect(ablationVerdict(runs, { ...rule, alpha: 0.01 })).toMatchObject({ verdict: 'no-effect', reason: 'NOT_SIGNIFICANT' });
    expect(ablationVerdict(runsOf({ off: '11000', on: '11100', irrelevant: '11000' }), { ...rule, alpha: 0.5 }))
      .toMatchObject({ verdict: 'helps', reason: 'GAIN' });
    expect(() => ablationVerdict(runs, { ...rule, alpha: 0 })).toThrow(RangeError);
    expect(() => ablationVerdict(runs, { ...rule, alpha: 0.6 })).toThrow(RangeError);
  });
});

describe('ablationVerdict: infrastructure errors (rv-r1)', () => {
  it('does not read an infrastructure error under one condition as an effect of memory', () => {
    // One errored `off` run, every answered run passed: under the old aggregate rule memory "helped".
    expect(ablationVerdict(runsOf({ off: '1111e', on: '11111', irrelevant: '11111' }), rule))
      .toMatchObject({ verdict: 'inconclusive', reason: 'UNBALANCED_ERRORS' });
    // Balanced errors are left out of the rates: 4/4 everywhere is no effect.
    expect(ablationVerdict(runsOf({ off: '1111e', on: '1111e', irrelevant: '1111e' }), rule))
      .toMatchObject({ verdict: 'no-effect', reason: 'WITHIN_ONE_TASK' });
    // With repeats, one task's worth is `repeats` runs: one extra error out of 10 runs over 5 tasks is not yet unbalanced.
    expect(ablationVerdict(runsOf({ off: [...each(4, '10'), '0e'], on: each(5, '11'), irrelevant: each(5, '10') }), rule))
      .toMatchObject({ verdict: 'helps', reason: 'GAIN' });
  });
});

describe('ablationVerdict: errors must not decide it, nor void an effect that survives them', () => {
  it('keeps helps when one off run errored and the gain holds however it would have ended (live L2 case)', () => {
    expect(ablationVerdict(runsOf({ off: '00000000000e', on: '111111111111', irrelevant: '000000000000' }), rule))
      .toMatchObject({ verdict: 'helps', reason: 'GAIN' });
  });

  it('refuses helps when errored off runs could have been the passes that close the gap', () => {
    // Answered only: on 5/5 vs off 0/2 looks like a gain; counting off's errors as passes it is 5/5 vs 3/5.
    expect(ablationVerdict(runsOf({ off: '00eee', on: '11111', irrelevant: '00000' }), { ...rule, maxErrorRate: 0.6 }))
      .toMatchObject({ verdict: 'inconclusive', reason: 'UNBALANCED_ERRORS' });
  });

  it('refuses helps when on errored exactly where off passed (its errors would be the losses)', () => {
    expect(ablationVerdict(runsOf({ off: '0000011111', on: '11111eeeee', irrelevant: '0000000000' }), { ...rule, maxErrorRate: 0.6 }))
      .toMatchObject({ verdict: 'inconclusive', reason: 'UNBALANCED_ERRORS' });
  });
});
