import { digest, freeze, hash, identifier, jsonClone, ownObject } from '../../shared/json.js';
import type { JsonValue } from '../workflow/types.js';
import { evaluateMemoryGate } from './gate.js';
import type { MemoryConditionTally, MemoryGateEvidence, MemoryGateVerdict } from './gate.js';

/** The three conditions every task runs under, always in this order. */
export type MemoryCondition = 'no-memory' | 'memory' | 'full-history';
const CONDITIONS: readonly MemoryCondition[] = ['no-memory', 'memory', 'full-history'];

export interface MemoryMeasurementTask {
  id: string;
  input: JsonValue;
}

export interface MemoryRunContext {
  condition: MemoryCondition;
  /** Empty under no-memory; the recalled items under memory; the whole history under full-history. */
  context: readonly string[];
  signal?: AbortSignal;
}

/** What the caller's runner reports for one task under one condition. */
export interface MemoryRunOutcome {
  passed: boolean;
  score?: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface MeasureMemoryOptions {
  id: string;
  tasks: readonly MemoryMeasurementTask[];
  /**
   * Content digests (`MemoryRecordView.contentDigest`) of the memory records
   * under test; copied into the gate evidence, which then promotes only them.
   */
  candidateDigests: readonly string[];
  /** Context of the memory condition: what recall would deliver for this task. */
  recall(task: MemoryMeasurementTask, signal?: AbortSignal): MaybePromise<readonly string[]>;
  /** Context of the full-history control: everything, unfiltered. */
  history(task: MemoryMeasurementTask, signal?: AbortSignal): MaybePromise<readonly string[]>;
  /** Runs one task with the given context. The harness makes no model call of its own. */
  run(task: MemoryMeasurementTask, context: MemoryRunContext): MaybePromise<MemoryRunOutcome>;
  signal?: AbortSignal;
}

export interface MemoryTaskOutcome {
  passed: boolean;
  score?: number;
  /** The context provider or the runner threw, or returned something unusable. Counted as not passed. */
  error?: true;
  contextItems: number;
  contextChars: number;
}

export interface MemoryConditionSummary extends MemoryConditionTally {
  passRate: number;
  errors: number;
  /** Context handed to the runner across the task set: the cost side of the comparison. */
  contextItems: number;
  contextChars: number;
}

export interface MemoryMeasurementReport {
  format: 1;
  id: string;
  candidateDigests: readonly string[];
  conditions: Readonly<Record<MemoryCondition, MemoryConditionSummary>>;
  tasks: readonly { id: string; outcomes: Readonly<Record<MemoryCondition, MemoryTaskOutcome>> }[];
  /** Pass-rate differences. Memory is judged against both controls, never alone. */
  deltas: { memoryVsNoMemory: number; memoryVsFullHistory: number };
  /** The rule a promotion applies: memory must beat the no-memory control. */
  verdict: MemoryGateVerdict;
  /** Ready to hand to `promote`; its digest is this report's digest. */
  gate: MemoryGateEvidence;
  digest: string;
}

function captureOptions(input: MeasureMemoryOptions) {
  const options = ownObject(input, ['id', 'tasks', 'candidateDigests', 'recall', 'history', 'run', 'signal']);
  identifier(options.id);
  for (const key of ['recall', 'history', 'run'] as const) {
    if (typeof options[key] !== 'function') throw new TypeError(`${key} must be a function`);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  const tasks = jsonClone(options.tasks);
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 1024) {
    throw new TypeError('tasks must hold 1 to 1024 tasks');
  }
  for (const task of tasks) {
    ownObject(task, ['id', 'input']);
    identifier(task.id);
    if (task.input === undefined) throw new TypeError('Every task needs an input');
  }
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new TypeError('Task ids must be unique');
  const candidateDigests = jsonClone(options.candidateDigests);
  if (!Array.isArray(candidateDigests) || candidateDigests.length === 0 || candidateDigests.length > 64) {
    throw new TypeError('candidateDigests must list 1 to 64 record content digests');
  }
  candidateDigests.forEach(candidate => hash(candidate));
  if (new Set(candidateDigests).size !== candidateDigests.length) {
    throw new TypeError('candidateDigests must be distinct');
  }
  return { ...options, tasks: freeze(tasks), candidateDigests: freeze(candidateDigests) };
}

function contextOf(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError('A context must be an array of strings');
  }
  return Object.freeze([...value]);
}

function failed(context: readonly string[] = []): MemoryTaskOutcome {
  return { passed: false, error: true, ...size(context) };
}

function size(context: readonly string[]) {
  return {
    contextItems: context.length,
    contextChars: context.reduce((total, item) => total + item.length, 0),
  };
}

/**
 * Runs the same task set under three conditions — no memory, memory, full
 * history — through the caller's runner, and reports the three outcomes side by
 * side. This is the only shape a claim about memory may take: a comparison
 * against both controls.
 *
 * A caller can rely on:
 * - Every task runs under all three conditions, in a fixed order; there is no
 *   partial report. An abort rejects instead.
 * - The no-memory context is always empty; the harness builds it, not the caller.
 * - A failing context provider or runner counts as a task that did not pass and
 *   is flagged, so one broken run cannot make a condition look better.
 * - The report is deterministic for the same outcomes and carries its own digest.
 *
 * It does not judge honesty: the runner and both context functions are the
 * caller's, and the result is only as good as they are.
 */
export async function measureMemory(input: MeasureMemoryOptions): Promise<MemoryMeasurementReport> {
  const options = captureOptions(input);
  const { signal } = options;
  const providers: Record<MemoryCondition, (task: MemoryMeasurementTask) => MaybePromise<readonly string[]>> = {
    'no-memory': () => [],
    memory: task => options.recall(task, signal),
    'full-history': task => options.history(task, signal),
  };
  const tasks: MemoryMeasurementReport['tasks'][number][] = [];

  for (const task of options.tasks) {
    const outcomes = {} as Record<MemoryCondition, MemoryTaskOutcome>;
    for (const condition of CONDITIONS) {
      signal?.throwIfAborted();
      outcomes[condition] = await runOne(task, condition, providers[condition], options.run, signal);
      signal?.throwIfAborted();
    }
    tasks.push({ id: task.id, outcomes });
  }

  const conditions = {} as Record<MemoryCondition, MemoryConditionSummary>;
  for (const condition of CONDITIONS) {
    const outcomes = tasks.map(task => task.outcomes[condition]);
    const passed = outcomes.filter(outcome => outcome.passed).length;
    conditions[condition] = {
      passed,
      total: outcomes.length,
      passRate: passed / outcomes.length,
      errors: outcomes.filter(outcome => outcome.error).length,
      contextItems: outcomes.reduce((total, outcome) => total + outcome.contextItems, 0),
      contextChars: outcomes.reduce((total, outcome) => total + outcome.contextChars, 0),
    };
  }
  const tally = (condition: MemoryCondition): MemoryConditionTally => ({
    passed: conditions[condition].passed,
    total: conditions[condition].total,
  });
  const body = {
    format: 1 as const,
    id: options.id,
    candidateDigests: options.candidateDigests,
    conditions,
    tasks,
    deltas: {
      memoryVsNoMemory: conditions.memory.passRate - conditions['no-memory'].passRate,
      memoryVsFullHistory: conditions.memory.passRate - conditions['full-history'].passRate,
    },
  };
  const reportDigest = digest(body);
  const gate: MemoryGateEvidence = {
    measurementId: options.id,
    digest: reportDigest,
    candidateDigests: options.candidateDigests,
    noMemory: tally('no-memory'),
    memory: tally('memory'),
    fullHistory: tally('full-history'),
  };
  return freeze({ ...body, verdict: evaluateMemoryGate(gate), gate, digest: reportDigest });
}

async function runOne(
  task: MemoryMeasurementTask,
  condition: MemoryCondition,
  provide: (task: MemoryMeasurementTask) => MaybePromise<readonly string[]>,
  run: MeasureMemoryOptions['run'],
  signal: AbortSignal | undefined,
): Promise<MemoryTaskOutcome> {
  let context: readonly string[];
  try {
    context = contextOf(await provide(task));
  } catch {
    return failed();
  }
  try {
    const result = await run(task, { condition, context, ...(signal ? { signal } : {}) });
    if (!result || typeof result.passed !== 'boolean') return failed(context);
    const outcome: MemoryTaskOutcome = { passed: result.passed, ...size(context) };
    if (result.score !== undefined) {
      if (typeof result.score !== 'number' || !Number.isFinite(result.score)) return failed(context);
      outcome.score = result.score;
    }
    return outcome;
  } catch {
    return failed(context);
  }
}
