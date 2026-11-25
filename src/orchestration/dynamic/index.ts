/**
 * Dynamic workflows: model- or application-authored orchestrations of real agent turns, run under hard
 * limits, journaled per call and resumable. Node-only; the Agent class is loaded on first use.
 *
 * - Scripts: `runWorkflowScript(meta, script, options)` over a `DynamicWorkflowContext`.
 * - Plans: JSON data a model can write (`planWorkflow`), validated (`validatePlan`), estimated
 *   (`estimatePlan`) and run (`runWorkflowPlan`).
 * - Agents: `agentRunner` builds each call's Agent from the application's own options under a
 *   permission ceiling and a model allowlist; `gitWorktreeIsolation` gives a call its own worktree.
 */
import { compileValidatedPlan } from './plan-compile.js';
import { runWorkflowScript } from './engine.js';
import { dynamicUsageError, strictJson } from './limits.js';
import { checkPlanArgs, validatePlan } from './plan.js';
import type { DynamicRunOptions, DynamicRunReport, DynamicWorkflowPlan, JsonValue } from './types.js';

export type * from './types.js';

export { runWorkflowScript, createDynamicEngine } from './engine.js';
export type { DynamicClock, DynamicEngineOptions, DynamicLaunchGate } from './engine.js';
export { memoryDynamicJournal, fileDynamicJournal } from './journal.js';
export type { FileDynamicJournal, DynamicJournalOwner, ManagedDynamicJournal } from './journal.js';
export {
  DynamicJournalCorruptError, DynamicJournalLockedError, DynamicJournalWriteError, validateDynamicRunId,
} from './journal-records.js';
export { DYNAMIC_LIMIT_BOUNDS, resolveDynamicLimits, validateDynamicMeta } from './limits.js';

export { validatePlan, estimatePlan, checkPlanArgs, planWaves, DYNAMIC_PLAN_JSON_SCHEMA, PLAN_BOUNDS } from './plan.js';
export type { DynamicPlanEstimate, DynamicAgentCount, PlanLimits } from './plan.js';
export { DynamicPlanError, DynamicPlannerError } from './plan-error.js';
export type { DynamicPlanErrorCode, DynamicPlanIssue } from './plan-error.js';
export { compilePlan } from './plan-compile.js';
export { renderTemplate, templateReferences, MAX_RENDERED_PROMPT_BYTES } from './template.js';
export { planWorkflow, PLANNER_INSTRUCTIONS } from './planner.js';
export type { PlanWorkflowOptions, PlannerAgentOptions, PlannedWorkflow } from './planner.js';

export { agentRunner, DynamicRunnerError } from './agent-runner.js';
export type { AgentRunnerOptions, DynamicRunnerErrorCode } from './agent-runner.js';
export { gitWorktreeIsolation, DynamicIsolationError } from './isolation.js';
export type {
  DynamicIsolationErrorCode, GitWorktreeIsolation, GitWorktreeIsolationOptions, WorktreeCleanupReport,
} from './isolation.js';

/**
 * Validates and runs a plan under the run's limits, then `runWorkflowScript`. Before anything runs it
 * rejects with `DynamicPlanError` for an invalid plan or args that do not fit it (`checkPlanArgs`), and
 * with a TypeError for malformed limits or args, or for a step asking `isolation: 'worktree'` when the run
 * has no `DynamicRunOptions.isolation`. A plan error found mid-run (a map over a failed step's `null`) ends
 * the run `failed` with code PLAN_INVALID; agent failures are in the report.
 */
export async function runWorkflowPlan(plan: DynamicWorkflowPlan | unknown, options: DynamicRunOptions): Promise<DynamicRunReport> {
  if (typeof options !== 'object' || options === null) throw dynamicUsageError('Run options must be a plain object');
  const validated = validatePlan(plan, options.limits);
  let args: JsonValue;
  try { args = strictJson(options.args === undefined ? null : options.args); }
  catch { throw dynamicUsageError('Run args must be strict JSON'); }
  checkPlanArgs(validated, args, options.limits);
  if (options.isolation === undefined) {
    const isolated = validated.steps.findIndex(step => step.isolation === 'worktree');
    if (isolated >= 0) {
      throw dynamicUsageError(`$.steps[${isolated}].isolation: 'worktree' requires DynamicRunOptions.isolation`);
    }
  }
  const { meta, script } = compileValidatedPlan(validated, options.limits);
  return runWorkflowScript(meta, script, options);
}
