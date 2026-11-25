import { signTestPValue } from './curator-acceptance.js';

/**
 * The ablation suite's verdict rule, on its own so it can be checked against synthetic runs.
 *
 * It is a paired test over tasks, the same rule family as the curator's acceptance: every task
 * ran under every condition, so per task the conditions' pass rates are compared, and a one-sided
 * exact sign test over the discordant tasks (`signTestPValue`) gives the chance of a result at
 * least this lopsided from noise alone. Concordant tasks say nothing about memory and are left
 * out. An effect also needs the one-task margin on the pooled pass rates, so a significant but
 * negligible difference (one run in many repeats) is still no effect.
 */

export type AblationCondition = 'off' | 'on' | 'irrelevant';
export const ABLATION_CONDITIONS: readonly AblationCondition[] = ['off', 'on', 'irrelevant'];

export type AblationVerdict = 'helps' | 'hurts' | 'no-effect' | 'inconclusive';
export type AblationVerdictReason =
  | 'TOO_FEW_TASKS' | 'NO_RUNS' | 'TOO_MANY_ERRORS' | 'UNBALANCED_ERRORS'
  | 'GAIN' | 'GAIN_NOT_ABOVE_IRRELEVANT' | 'LOSS' | 'WITHIN_ONE_TASK' | 'NOT_SIGNIFICANT';

export interface AblationRule {
  minTasks: number;
  maxErrorRate: number;
  /** One task's worth of pass rate: `1 / tasks`. A difference of pooled pass rates smaller than this is no difference. */
  margin: number;
  /** Significance level of the one-sided exact sign tests. */
  alpha: number;
}

/**
 * One paired comparison of `on` with another condition, over the tasks that have an answered run
 * under both: `better` tasks where `on` had the higher pass rate, `worse` the lower, `ties` equal.
 * `pBetter` is the one-sided sign test's p-value for "on is better", `pWorse` for "on is worse";
 * both are 1 without a discordant task.
 */
export interface AblationSignTest {
  better: number;
  worse: number;
  ties: number;
  pBetter: number;
  pWorse: number;
}

export interface AblationSignTests {
  onVsOff: AblationSignTest;
  onVsIrrelevant: AblationSignTest;
}

/** What the rule reads of a run: which task, which condition, and whether it passed or errored. */
export interface AblationOutcome {
  task: string;
  condition: AblationCondition;
  passed: boolean;
  /** Present when the run errored: an infrastructure failure, not an answer. */
  error?: unknown;
}

export interface AblationVerdictResult {
  verdict: AblationVerdict;
  reason: AblationVerdictReason;
  /** The sign tests over pass rates of answered runs (errored runs left out), whatever the verdict. */
  tests: AblationSignTests;
}

export const ABLATION_DEFAULT_ALPHA = 0.05;
const MAX_ALPHA = 0.5;
/** Floating point slack when a pooled delta is compared with the one-task margin. */
const EPSILON = 1e-9;

interface Tally { runs: number; passed: number; errors: number }
type TaskTallies = Record<AblationCondition, Tally>;

/** The significance level: default 0.05, above 0 and at most 0.5 (the curator's bounds). */
export function ablationAlpha(value: unknown): number {
  if (value === undefined) return ABLATION_DEFAULT_ALPHA;
  if (typeof value !== 'number' || !(value > 0 && value <= MAX_ALPHA)) {
    throw new RangeError(`alpha must be a number above 0 and at most ${MAX_ALPHA}`);
  }
  return value;
}

const empty = (): TaskTallies => ({
  off: { runs: 0, passed: 0, errors: 0 }, on: { runs: 0, passed: 0, errors: 0 }, irrelevant: { runs: 0, passed: 0, errors: 0 },
});

function tallies(runs: readonly AblationOutcome[]): Map<string, TaskTallies> {
  if (!Array.isArray(runs)) {
    throw new TypeError('ablationVerdict takes the runs (e.g. report.runs) and a rule: the paired test needs per-task outcomes');
  }
  const byTask = new Map<string, TaskTallies>();
  for (const run of runs as readonly (Partial<AblationOutcome> | null | undefined)[]) {
    const condition = run?.condition as AblationCondition;
    if (typeof run?.task !== 'string' || !ABLATION_CONDITIONS.includes(condition) || typeof run.passed !== 'boolean') {
      throw new TypeError('Every run needs a task id, a condition (off, on or irrelevant) and passed');
    }
    const task = byTask.get(run.task) ?? empty();
    byTask.set(run.task, task);
    const tally = task[condition];
    tally.runs += 1;
    if (run.error !== undefined) tally.errors += 1;
    else if (run.passed) tally.passed += 1;
  }
  return byTask;
}

/** How a reading counts errored runs: `answered` leaves them out, `failures` counts every one as a failure. */
type Reading = 'answered' | 'failures';

/** Pass rate as a fraction under one reading of the errored runs. */
function fraction(tally: Tally, reading: Reading): { passed: number; of: number } {
  return { passed: tally.passed, of: reading === 'answered' ? tally.runs - tally.errors : tally.runs };
}

function signTest(tasks: readonly TaskTallies[], other: AblationCondition, reading: Reading): AblationSignTest {
  let better = 0;
  let worse = 0;
  let ties = 0;
  for (const task of tasks) {
    const on = fraction(task.on, reading);
    const them = fraction(task[other], reading);
    if (on.of === 0 || them.of === 0) continue;
    // Compared exactly, in integers: `on.passed / on.of` against `them.passed / them.of`.
    const difference = on.passed * them.of - them.passed * on.of;
    if (difference > 0) better += 1;
    else if (difference < 0) worse += 1;
    else ties += 1;
  }
  return { better, worse, ties, pBetter: signTestPValue(better, worse), pWorse: signTestPValue(worse, better) };
}

function tests(tasks: readonly TaskTallies[], reading: Reading): AblationSignTests {
  return { onVsOff: signTest(tasks, 'off', reading), onVsIrrelevant: signTest(tasks, 'irrelevant', reading) };
}

/** Steps 4 to 7 of `ablationVerdict` over one reading of the outcomes. */
function compare(
  tasks: readonly TaskTallies[], reading: Reading, alpha: number,
): { verdict: AblationVerdict; reason: AblationVerdictReason; tests: AblationSignTests } {
  const pooled = (condition: AblationCondition) => {
    let passed = 0;
    let of = 0;
    for (const task of tasks) {
      const rate = fraction(task[condition], reading);
      passed += rate.passed;
      of += rate.of;
    }
    return of === 0 ? 0 : passed / of;
  };
  const margin = 1 / tasks.length - EPSILON;
  const paired = tests(tasks, reading);
  const onVsOff = pooled('on') - pooled('off');
  if (onVsOff >= margin && paired.onVsOff.pBetter <= alpha) {
    const aboveIrrelevant = pooled('on') - pooled('irrelevant') >= margin && paired.onVsIrrelevant.pBetter <= alpha;
    return aboveIrrelevant
      ? { verdict: 'helps', reason: 'GAIN', tests: paired }
      : { verdict: 'inconclusive', reason: 'GAIN_NOT_ABOVE_IRRELEVANT', tests: paired };
  }
  if (-onVsOff >= margin && paired.onVsOff.pWorse <= alpha) return { verdict: 'hurts', reason: 'LOSS', tests: paired };
  if (Math.abs(onVsOff) < margin) return { verdict: 'no-effect', reason: 'WITHIN_ONE_TASK', tests: paired };
  return { verdict: 'no-effect', reason: 'NOT_SIGNIFICANT', tests: paired };
}

/**
 * The verdict over the runs of one suite (`MemoryAblationReport.runs`, or synthetic ones). Pass
 * rates are taken over the runs that did not error: an errored run is an infrastructure failure,
 * not a wrong answer, and must not make another condition look better.
 * 1. fewer than `minTasks` tasks: `inconclusive` (TOO_FEW_TASKS);
 * 2. a condition without a single run that did not error: `inconclusive` (NO_RUNS);
 * 3. any condition with errored runs above `maxErrorRate`: `inconclusive` (TOO_MANY_ERRORS);
 * 4. `on` better than `off` by the sign test at `alpha` (default 0.05) and by at least one
 *    task's worth of pooled pass rate (`1 / tasks`): `helps` when `on` also beats `irrelevant`
 *    the same way, otherwise `inconclusive` (GAIN_NOT_ABOVE_IRRELEVANT: any context of that
 *    shape did about as well, so the gain is not this memory's);
 * 5. `on` worse than `off` the same way: `hurts` (LOSS);
 * 6. a pooled difference under one task's worth: `no-effect` (WITHIN_ONE_TASK);
 * 7. otherwise `no-effect` (NOT_SIGNIFICANT: a difference noise alone makes often enough).
 *
 * When any run errored, steps 4 to 7 are taken again with every errored run counted as a failure
 * (rates over all runs). Errors concentrated in one condition can then decide the verdict either
 * way (a memory whose wrong answers time out looks perfect over its answered runs), so if the two
 * readings disagree the verdict is `inconclusive` (UNBALANCED_ERRORS). Before, any difference of
 * a task's worth of errors between conditions was already `inconclusive`; that voided clear
 * effects over a single infrastructure error, and simulation showed it added no protection the
 * second reading does not give (`scripts/simulation/memory/ablation.mjs`).
 *
 * Before format 2 the rule took aggregate tallies, `ablationVerdict(tasks, conditions, rule)`, and
 * needed no significance: a one-task difference was an effect. That form is refused with a TypeError.
 */
export function ablationVerdict(
  runs: readonly AblationOutcome[], rule: Pick<AblationRule, 'minTasks' | 'maxErrorRate'> & { alpha?: number },
): AblationVerdictResult {
  const byTask = tallies(runs);
  const alpha = ablationAlpha(rule?.alpha);
  const tasks = [...byTask.values()];
  const primary = tests(tasks, 'answered');
  const inconclusive = (reason: AblationVerdictReason): AblationVerdictResult => ({ verdict: 'inconclusive', reason, tests: primary });
  if (tasks.length < rule.minTasks) return inconclusive('TOO_FEW_TASKS');
  const total = (condition: AblationCondition): Tally => tasks.reduce(
    (sum, task) => ({
      runs: sum.runs + task[condition].runs, passed: sum.passed + task[condition].passed, errors: sum.errors + task[condition].errors,
    }), { runs: 0, passed: 0, errors: 0 });
  const conditions = Object.fromEntries(ABLATION_CONDITIONS.map(condition => [condition, total(condition)])) as TaskTallies;
  if (ABLATION_CONDITIONS.some(condition => !(conditions[condition].runs - conditions[condition].errors > 0))) {
    return inconclusive('NO_RUNS');
  }
  if (ABLATION_CONDITIONS.some(condition => conditions[condition].errors > rule.maxErrorRate * conditions[condition].runs)) {
    return inconclusive('TOO_MANY_ERRORS');
  }
  const overAnswered = compare(tasks, 'answered', alpha);
  if (ABLATION_CONDITIONS.every(condition => conditions[condition].errors === 0)) return overAnswered;
  const check = compare(tasks, 'failures', alpha);
  return check.verdict === overAnswered.verdict && check.reason === overAnswered.reason
    ? overAnswered
    : inconclusive('UNBALANCED_ERRORS');
}
