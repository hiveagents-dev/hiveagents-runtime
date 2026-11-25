/**
 * Dynamic workflows: the engine entry.
 *
 * `runWorkflowScript(meta, script, options)` validates the meta, limits and options (TypeError when
 * invalid), opens the journal run when the journal has a lifecycle (its typed error refuses the run:
 * another writer, corruption), runs the script over a `DynamicWorkflowContext` and resolves to a
 * `DynamicRunReport`. It never rejects for agent or script failures: they are in the report.
 *
 * The one exception is an execution halt (`ExecutionHaltedError`, a failed infrastructure boundary):
 * the first halt aborts the run's signal, so no further agent call is dispatched and calls in flight
 * are cancelled; after they settle and the journal closes, `run.finished` is emitted with 'failed'
 * and the run rejects with that halt, as `WorkflowRunner` does.
 *
 * Status precedence: 'aborted' (the caller's signal aborted) > 'budget-exhausted' (a call was refused
 * BUDGET) > 'failed' (SCRIPT_ERROR: the script threw or returned non-JSON; PLAN_INVALID: a compiled
 * plan threw `DynamicPlanError`, reported with its code and path; JOURNAL: a journal read, write or close
 * failed) > 'completed'. Agent failures alone never fail the run: the script decides.
 *
 * After the script settles the engine waits for agent calls still in flight (a script that failed has
 * them aborted first), then emits `run.finished` — always, once `run.started` was emitted.
 */
import { isExecutionHalted } from '../../public/execution-halt.js';
import { freeze } from '../../shared/json.js';
import { DynamicRun } from './context.js';
import { DynamicPlanError } from './plan-error.js';
import type { DynamicLaunchGate } from './agent-call.js';
import { realClock, type DynamicClock } from './concurrency.js';
import { validateDynamicRunId, type DynamicJournalLifecycle } from './journal-records.js';
import {
  dynamicUsageError, isDynamicUsageError, plainObject, resolveDynamicLimits, strictJson, validateDynamicMeta,
} from './limits.js';
import type {
  DynamicIsolation, DynamicJournal, DynamicAgentRunner, DynamicRunOptions, DynamicRunReport, DynamicRunStatus,
  DynamicWorkflowEvent, DynamicWorkflowMeta, DynamicWorkflowScript, JsonValue, RunWorkflowScript,
} from './types.js';

export type { DynamicLaunchGate } from './agent-call.js';
export type { DynamicClock } from './concurrency.js';

/** Engine-wide options (not per run), shared by every run of this engine. */
export interface DynamicEngineOptions {
  /**
   * Held from just before an agent attempt starts until its runner settles (given up while a rate-limited
   * call backs off); a refusal fails the call with LAUNCH.
   */
  readonly launch?: DynamicLaunchGate;
  /** The time source of rate-limit backoff waits (tests, simulations); default real time. */
  readonly clock?: DynamicClock;
}

const RUN_OPTION_KEYS = ['runId', 'runner', 'journal', 'isolation', 'limits', 'args', 'signal', 'onEvent'];

function methods(value: unknown, field: string, names: readonly string[]): void {
  if (typeof value !== 'object' || value === null || names.some(name => typeof (value as Record<string, unknown>)[name] !== 'function')) {
    throw dynamicUsageError(`${field} must be an object with ${names.join(', ')}`);
  }
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === 'string' && name !== 'Error' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? ` (${name})` : '';
}

/**
 * Only messages the SDK authored are reported; anything else could carry provider text. A plan error
 * (thrown by a compiled plan mid-run) keeps its code and JSON path: PLAN_INVALID.
 */
// Plan keys an error path may name; anything else (a key a model wrote) is reduced to `*`.
const PLAN_PATH_KEYS = new Set([
  'format', 'meta', 'name', 'description', 'phases', 'title', 'detail', 'steps', 'result', 'kind', 'id', 'prompt',
  'over', 'maxItems', 'schema', 'model', 'effort', 'permissions', 'isolation', 'timeoutMs', 'phase',
]);

/** A JSON path with only `$`, `[n]` and known plan keys: never text a model wrote. */
function planPath(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('$')) return '$';
  const segments = path.slice(1).match(/\[\d{1,6}\]|\.[^.[\]]*/g) ?? [];
  return '$' + segments.slice(0, 16).map(segment =>
    segment.startsWith('[') || PLAN_PATH_KEYS.has(segment.slice(1)) ? segment : '.*').join('');
}

function scriptFailure(error: unknown): NonNullable<DynamicRunReport['error']> {
  if (error instanceof DynamicPlanError) {
    // The code is closed and the path is reduced to known segments: a plan an agent wrote and the script
    // validated could otherwise put the model's own key text into the report.
    return { code: 'PLAN_INVALID', message: `The plan failed (${error.code}) at ${planPath(error.path)}` };
  }
  return {
    code: 'SCRIPT_ERROR',
    message: isDynamicUsageError(error)
      ? `The workflow script failed: ${error.message}`.slice(0, 1024)
      : `The workflow script threw${errorName(error)}`,
  };
}

/** Builds an engine; `createDynamicEngine({ launch })` adds a host-wide launch gate. */
export function createDynamicEngine(engine: DynamicEngineOptions = {}): RunWorkflowScript {
  const { launch, clock = realClock } = plainObject(engine, 'Engine options', ['launch', 'clock']) as DynamicEngineOptions;
  if (launch !== undefined) methods(launch, 'Engine launch gate', ['acquire']);
  methods(clock, 'Engine clock', ['now', 'sleep']);
  return (meta, script, options) => runScript(meta, script, options, launch, clock);
}

/** The default engine (no launch gate). */
export const runWorkflowScript: RunWorkflowScript = createDynamicEngine();

async function runScript(
  metaInput: DynamicWorkflowMeta, script: DynamicWorkflowScript, input: DynamicRunOptions, launch: DynamicLaunchGate | undefined,
  clock: DynamicClock,
): Promise<DynamicRunReport> {
  const options = plainObject(input, 'Run options', RUN_OPTION_KEYS) as Partial<DynamicRunOptions>;
  let runId: string;
  try { runId = validateDynamicRunId(options.runId); }
  catch { throw dynamicUsageError('Run id must match ^[A-Za-z0-9._-]{1,128}$'); }
  const meta = validateDynamicMeta(metaInput);
  if (typeof script !== 'function') throw dynamicUsageError('Workflow script must be a function');
  methods(options.runner, 'Run runner', ['run']);
  if (options.journal !== undefined) methods(options.journal, 'Run journal', ['get', 'put']);
  if (options.isolation !== undefined) methods(options.isolation, 'Run isolation', ['create', 'inspect']);
  const limits = resolveDynamicLimits(options.limits);
  let args: JsonValue;
  try { args = freeze(strictJson(options.args === undefined ? null : options.args)); }
  catch { throw dynamicUsageError('Run args must be strict JSON'); }
  const external = options.signal;
  if (external !== undefined && !(external instanceof AbortSignal)) throw dynamicUsageError('Run signal must be an AbortSignal');
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') throw dynamicUsageError('Run onEvent must be a function');

  const journal = options.journal as (DynamicJournal & DynamicJournalLifecycle) | undefined;
  if (typeof journal?.open === 'function') await journal.open(runId);

  const controller = new AbortController();
  const forward = () => controller.abort(external?.reason);
  external?.addEventListener('abort', forward, { once: true });
  let halt: { error: unknown } | undefined;
  const halted = (error: unknown) => { if (halt === undefined) { halt = { error }; controller.abort(error); } };
  const run = new DynamicRun({
    runId, meta, limits, args, launch, clock, signal: controller.signal,
    runner: options.runner as DynamicAgentRunner,
    journal, isolation: options.isolation as DynamicIsolation | undefined, onEvent: options.onEvent,
    halt: halted,
  });
  const at = () => new Date().toISOString();
  run.emit({ type: 'run.started', runId, meta, at: at() });

  type Outcome = { kind: 'returned'; value: unknown } | { kind: 'threw'; error: unknown } | { kind: 'not-started' };
  let outcome: Outcome = { kind: 'not-started' };
  let closeFailed = false;
  try {
    if (external?.aborted) forward();
    else {
      try { outcome = { kind: 'returned', value: await script(run.context()) }; }
      catch (error) {
        outcome = { kind: 'threw', error };
        if (isExecutionHalted(error)) halted(error);
        else controller.abort(new Error('The workflow script failed'));
      }
    }
    await run.drain();
    // A context kept past the run cannot start agents: later calls resolve 'skipped' without the journal.
    controller.abort(new Error('The run has finished'));
  } finally {
    external?.removeEventListener('abort', forward);
    if (typeof journal?.close === 'function') {
      try { await journal.close(runId); }
      catch (error) { if (isExecutionHalted(error)) halted(error); else closeFailed = true; }
    }
  }

  let result: JsonValue = null;
  let invalidResult = false;
  if (outcome.kind === 'returned') {
    try { result = strictJson(outcome.value); } catch { invalidResult = true; }
  }
  let status: DynamicRunStatus = 'completed';
  let error: DynamicRunReport['error'];
  if (external?.aborted) {
    status = 'aborted'; error = { code: 'ABORTED', message: 'The run was aborted' };
  } else if (run.budgetExhausted) {
    status = 'budget-exhausted'; error = { code: 'BUDGET', message: `The run token budget (${limits.tokens}) was spent` };
  } else if (outcome.kind === 'threw') {
    status = 'failed'; error = scriptFailure(outcome.error);
  } else if (invalidResult) {
    status = 'failed'; error = { code: 'SCRIPT_ERROR', message: 'The workflow script returned a value that is not strict JSON' };
  } else if (run.journalFailures > 0 || closeFailed) {
    status = 'failed';
    error = { code: 'JOURNAL', message: closeFailed ? 'The journal could not close the run; its lock may remain' : 'The journal could not read or record an agent result' };
  }
  if (halt !== undefined) status = 'failed';
  const agents = run.summaries();
  const finished: DynamicWorkflowEvent = { type: 'run.finished', runId, status, agents: agents.length, spent: run.spent, at: at() };
  run.emit(finished);
  if (halt !== undefined) throw halt.error;
  return { runId, status, result, agents, spent: run.spent, ...(error === undefined ? {} : { error }) };
}
