import type { AblationCondition } from '../../src/orchestration/memory/ablation.js';

export type AblationOutcomeRun = { task: string; condition: AblationCondition; repeat: number; passed: boolean; error?: 'turn' };

/**
 * Synthetic runs for `ablationVerdict`. Each condition gives one string per task, one character
 * per repeat: `1` passed, `0` failed, `e` errored. A single string is one repeat per task.
 */
export function runsOf(table: Partial<Record<AblationCondition, string | string[]>>): AblationOutcomeRun[] {
  const runs: AblationOutcomeRun[] = [];
  for (const [condition, spec] of Object.entries(table) as [AblationCondition, string | string[]][]) {
    const perTask = typeof spec === 'string' ? [...spec] : spec;
    perTask.forEach((repeats, index) => {
      [...repeats].forEach((outcome, repeat) => {
        const run: AblationOutcomeRun = { task: `t${index + 1}`, condition, repeat: repeat + 1, passed: outcome === '1' };
        if (outcome === 'e') run.error = 'turn';
        runs.push(run);
      });
    });
  }
  return runs;
}

/** The same string for `count` tasks. */
export const each = (count: number, repeats: string) => Array.from({ length: count }, () => repeats);
