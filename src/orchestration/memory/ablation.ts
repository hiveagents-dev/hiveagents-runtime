import type { Agent } from '../../public/agent.js';
import type {
  AgentMemoryProvider, AgentMemoryScope, MemoryOption, MemoryTurnNote,
} from '../../public/memory-types.js';
import type { AgentInput, Turn } from '../../public/types.js';
import { digest, freeze, identifier } from '../../shared/json.js';
import { ABLATION_CONDITIONS as CONDITIONS, ablationAlpha, ablationVerdict } from './ablation-verdict.js';
import type { AblationCondition, AblationRule, AblationSignTests, AblationVerdict, AblationVerdictReason } from './ablation-verdict.js';
import { MAX_TIMER_MS, abortable, boundedInteger, errorLabel, optionalSignal } from './curation-support.js';

/**
 * The memory ablation suite: the same tasks, run for real through the
 * application's Agents, with memory off, on, and on with plausible but unrelated
 * items. It answers one question, with evidence an application can commit:
 * does this memory make the agent better than no memory AND better than any
 * context of the same shape?
 */

export { ABLATION_DEFAULT_ALPHA, ablationVerdict } from './ablation-verdict.js';
export type {
  AblationCondition, AblationOutcome, AblationRule, AblationSignTest, AblationSignTests, AblationVerdict,
  AblationVerdictReason, AblationVerdictResult,
} from './ablation-verdict.js';

export interface AblationTask {
  id: string;
  input: AgentInput;
  /** Whether the turn solved the task. A throw or a non-boolean counts as an error, not a pass. */
  check(turn: Turn): boolean | Promise<boolean>;
}

/** What the suite needs from an Agent; a real `Agent` has it. */
export type AblationAgent = Pick<Agent, 'send' | 'close'>;

export interface AblationRunContext {
  readonly condition: AblationCondition;
  readonly taskId: string;
  readonly repeat: number;
}

export interface MemoryAblationOptions {
  id: string;
  tasks: readonly AblationTask[];
  /** The memory under test. Every condition runs it with `capture: false`: an ablation never writes memory. */
  memory: MemoryOption;
  /**
   * Builds a fresh Agent for one run; it must pass `memory` unchanged as `AgentOptions.memory`
   * (`false` under `off`). The suite closes every Agent it gets, whatever happens.
   */
  makeAgent(memory: MemoryOption | false, context: AblationRunContext): AblationAgent | Promise<AblationAgent>;
  /** The `irrelevant` condition's provider: returns plausible items that do not bear on the tasks. */
  irrelevantProvider?: AgentMemoryProvider;
  /**
   * Instead of `irrelevantProvider`: a different scope of the same store. The built-in decoy asks
   * `memory.provider` to recall from this scope, so the items have the store's own shape and
   * size but come from unrelated work. Exactly one of the two is required. It must name the same
   * tenant as `memory.scope` (another tenant is refused); its items reach the model of every
   * `irrelevant` run, so pick a namespace or subject whose memory may be shown to these tasks.
   */
  irrelevantScope?: AgentMemoryScope;
  /** Runs per task and condition: default 1, at most 16. */
  repeats?: number;
  /** Runs in flight at once: default 1 (sequential), at most 8. */
  concurrency?: number;
  /** Deadline of one run (agent build, turn and check) in milliseconds. Default: 600 000. */
  timeoutMs?: number;
  /** Fewer tasks than this is `inconclusive`. Default 5. */
  minTasks?: number;
  /** A condition with a larger share of errored runs makes the verdict `inconclusive`. Default 0.25. */
  maxErrorRate?: number;
  /**
   * Significance level of the one-sided exact sign tests over tasks (see `ablationVerdict`): the
   * most often a memory with no effect is reported as `helps`. Default 0.05, above 0, at most 0.5.
   */
  alpha?: number;
  /**
   * Aborting rejects the suite with the signal's reason, after every Agent it built was closed;
   * an Agent still being built is awaited (at most `min(timeoutMs, 10 s)`) and closed too.
   */
  signal?: AbortSignal;
}

export type AblationRunError = 'make-agent' | 'turn' | 'check' | 'timeout';

/** What memory did on a run: ids, sources and sizes, never the recalled text. */
export type AblationMemoryNote =
  | { status: 'recalled'; items: { id: string; source: string; bytes: number }[]; omitted: number; bytes: number }
  | { status: 'empty' }
  | { status: 'failed' };

export interface AblationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reportedCostUsd?: number;
}

export interface AblationRun {
  task: string;
  condition: AblationCondition;
  repeat: number;
  passed: boolean;
  error?: AblationRunError;
  /** Code or class name of the failure; never its message. */
  errorName?: string;
  status?: Turn['status'];
  /** Wall time of the turn, in whole milliseconds. */
  latencyMs?: number;
  usage?: AblationUsage;
  memory?: AblationMemoryNote;
}

export interface AblationConditionSummary {
  runs: number;
  passed: number;
  /** `passed` over the runs that did not error; 0 when every run errored. Errored runs are infrastructure, not answers. */
  passRate: number;
  errors: number;
  recalledItems: number;
  recalledBytes: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * JSON-serializable evidence. Task ids, provider id, counts and sizes only: no prompt, no recalled text.
 * Format 2: the verdict is a paired sign test over tasks, `rule.alpha` and `tests` are new. A format 1
 * report's verdict compared pooled pass rates with a one-task margin only, and is not comparable.
 */
export interface MemoryAblationReport {
  format: 2;
  id: string;
  provider: string;
  tasks: string[];
  repeats: number;
  conditions: Record<AblationCondition, AblationConditionSummary>;
  deltas: { onVsOff: number; irrelevantVsOff: number; onVsIrrelevant: number };
  rule: AblationRule;
  verdict: AblationVerdict;
  reason: AblationVerdictReason;
  /** The paired sign tests over pass rates of answered runs, with their p-values. */
  tests: AblationSignTests;
  runs: AblationRun[];
  digest: string;
}

interface Captured {
  id: string;
  tasks: readonly AblationTask[];
  options: Record<AblationCondition, MemoryOption | false>;
  provider: string;
  makeAgent: MemoryAblationOptions['makeAgent'];
  repeats: number;
  concurrency: number;
  timeoutMs: number;
  minTasks: number;
  maxErrorRate: number;
  alpha: number;
  signal?: AbortSignal;
  /** Closes of Agents that arrived after their run gave up on them. */
  lateCloses: Set<Promise<void>>;
}

/** Longest wait for an Agent still being built when the suite ends. */
const LATE_CLOSE_GRACE_MS = 10_000;

/**
 * Recall only: a run can never capture or propose into the store under test, and no condition
 * carries a profile, so `on` and `irrelevant` differ from `off` by the recalled items alone. The
 * ablation measures recalled items; measure a profile on its own.
 */
function readOnly(provider: AgentMemoryProvider, recallScope?: AgentMemoryScope): AgentMemoryProvider {
  const recall = provider.recall!.bind(provider);
  return Object.freeze({
    id: provider.id,
    recall: recallScope
      ? (request: Parameters<typeof recall>[0]) => recall({ ...request, scope: recallScope })
      : (request: Parameters<typeof recall>[0]) => recall(request),
  });
}

function sameScope(a: AgentMemoryScope, b: AgentMemoryScope): boolean {
  return a.tenant === b.tenant && a.namespace === b.namespace && a.subject === b.subject;
}

function captureOptions(input: MemoryAblationOptions): Captured {
  if (!input || typeof input !== 'object') throw new TypeError('runMemoryAblation needs an options object');
  identifier(input.id);
  const { memory, irrelevantProvider, irrelevantScope } = input;
  if (typeof input.makeAgent !== 'function') throw new TypeError('makeAgent must be a function');
  if (!memory || typeof memory !== 'object' || typeof memory.provider?.recall !== 'function' || !memory.scope) {
    throw new TypeError('memory must be a MemoryOption whose provider implements recall()');
  }
  const tasks = input.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 1024) throw new TypeError('tasks must hold 1 to 1024 tasks');
  for (const task of tasks) {
    identifier(task?.id);
    if (typeof task.check !== 'function' || task.input === undefined) throw new TypeError('Every task needs an input and a check');
  }
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new TypeError('Task ids must be unique');
  if ((irrelevantProvider === undefined) === (irrelevantScope === undefined)) {
    throw new TypeError('Give exactly one of irrelevantProvider and irrelevantScope');
  }
  let decoy: AgentMemoryProvider;
  if (irrelevantProvider !== undefined) {
    if (typeof irrelevantProvider?.recall !== 'function') throw new TypeError('irrelevantProvider must implement recall()');
    decoy = readOnly(irrelevantProvider);
  } else {
    if (!irrelevantScope || typeof irrelevantScope !== 'object') throw new TypeError('irrelevantScope must be a scope');
    if (sameScope(irrelevantScope, memory.scope)) throw new TypeError('irrelevantScope must differ from memory.scope');
    if (irrelevantScope.tenant !== memory.scope.tenant) {
      throw new TypeError("irrelevantScope must name memory.scope's tenant: a decoy never shows another tenant's memory");
    }
    decoy = readOnly(memory.provider, { ...irrelevantScope });
  }
  const { onCaptureError: _unused, ...base } = memory;
  const on: MemoryOption = { ...base, provider: readOnly(memory.provider), capture: false };
  const maxErrorRate = input.maxErrorRate ?? 0.25;
  if (typeof maxErrorRate !== 'number' || !(maxErrorRate >= 0 && maxErrorRate <= 1)) {
    throw new RangeError('maxErrorRate must be a number from 0 to 1');
  }
  const captured: Captured = {
    id: input.id,
    tasks: [...tasks],
    options: { off: false, on, irrelevant: { ...on, provider: decoy } },
    provider: memory.provider.id,
    makeAgent: input.makeAgent,
    repeats: boundedInteger(input.repeats, 'repeats', 1, 16, 1),
    concurrency: boundedInteger(input.concurrency, 'concurrency', 1, 8, 1),
    timeoutMs: boundedInteger(input.timeoutMs, 'timeoutMs', 1, MAX_TIMER_MS, 600_000),
    minTasks: boundedInteger(input.minTasks, 'minTasks', 1, 1024, 5),
    maxErrorRate,
    alpha: ablationAlpha(input.alpha),
    lateCloses: new Set(),
  };
  const signal = optionalSignal(input.signal);
  if (signal) captured.signal = signal;
  return captured;
}

interface Item { task: AblationTask; condition: AblationCondition; repeat: number }

/**
 * Runs every task under `off`, `on` and `irrelevant`, `repeats` times each, in that order per
 * task (sequentially unless `concurrency` says otherwise), and reports pass rates, their
 * differences and a verdict (see `ablationVerdict`). Every run gets its own Agent from
 * `makeAgent`, so no session carries over between conditions; the Agent is closed after the run.
 * A failed build, turn or check, and a run past `timeoutMs`, are errored runs: reported by kind,
 * never passed, left out of the pass rates, and they never reject the suite. Only invalid options
 * (a TypeError or RangeError) and the caller's abort reject. No condition carries the provider's
 * profile: the suite measures recalled items only.
 */
export async function runMemoryAblation(input: MemoryAblationOptions): Promise<MemoryAblationReport> {
  const options = captureOptions(input);
  const { signal } = options;
  signal?.throwIfAborted();
  const items: Item[] = [];
  for (const task of options.tasks) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      for (const condition of CONDITIONS) items.push({ task, condition, repeat });
    }
  }
  const runs: AblationRun[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      runs[index] = await runOne(items[index]!, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, worker));
  await settleLateCloses(options);
  signal?.throwIfAborted();

  const conditions = {} as Record<AblationCondition, AblationConditionSummary>;
  for (const condition of CONDITIONS) conditions[condition] = summarize(runs.filter(run => run.condition === condition));
  const rate = (condition: AblationCondition) => conditions[condition].passRate;
  const rule: AblationRule = {
    minTasks: options.minTasks, maxErrorRate: options.maxErrorRate, margin: 1 / options.tasks.length, alpha: options.alpha,
  };
  const body = {
    format: 2 as const,
    id: options.id,
    provider: options.provider,
    tasks: options.tasks.map(task => task.id),
    repeats: options.repeats,
    conditions,
    deltas: {
      onVsOff: rate('on') - rate('off'),
      irrelevantVsOff: rate('irrelevant') - rate('off'),
      onVsIrrelevant: rate('on') - rate('irrelevant'),
    },
    rule,
    ...ablationVerdict(runs, rule),
    runs,
  };
  return freeze({ ...body, digest: digest(body) });
}

/** Waits for every Agent that arrived late to be closed, at most `min(timeoutMs, 10 s)`. */
async function settleLateCloses(options: Captured): Promise<void> {
  if (options.lateCloses.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>(resolve => {
    timer = setTimeout(resolve, Math.min(options.timeoutMs, LATE_CLOSE_GRACE_MS));
  });
  try {
    await Promise.race([Promise.allSettled([...options.lateCloses]), grace]);
  } finally {
    clearTimeout(timer);
  }
}

function summarize(runs: readonly AblationRun[]): AblationConditionSummary {
  const passed = runs.filter(run => run.passed).length;
  const errors = runs.filter(run => run.error !== undefined).length;
  const sum = (pick: (run: AblationRun) => number | undefined) => runs.reduce((total, run) => total + (pick(run) ?? 0), 0);
  return {
    runs: runs.length,
    passed,
    passRate: runs.length - errors === 0 ? 0 : passed / (runs.length - errors),
    errors,
    recalledItems: sum(run => (run.memory?.status === 'recalled' ? run.memory.items.length : 0)),
    recalledBytes: sum(run => (run.memory?.status === 'recalled' ? run.memory.bytes : 0)),
    latencyMs: sum(run => run.latencyMs),
    inputTokens: sum(run => run.usage?.inputTokens),
    outputTokens: sum(run => run.usage?.outputTokens),
  };
}

async function runOne({ task, condition, repeat }: Item, options: Captured): Promise<AblationRun> {
  const base = { task: task.id, condition, repeat };
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal!.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('The run deadline passed', 'TimeoutError'));
  }, options.timeoutMs);
  const { signal } = controller;
  const failed = (error: Exclude<AblationRunError, 'timeout'>, cause: unknown, extra: Partial<AblationRun> = {}): AblationRun =>
    (timedOut ? { ...base, passed: false, error: 'timeout', ...extra } : { ...base, passed: false, error, errorName: errorLabel(cause), ...extra });
  const making = Promise.resolve().then(() => options.makeAgent(options.options[condition], freeze({ condition, taskId: task.id, repeat })));
  let agent: AblationAgent | undefined;
  try {
    try {
      agent = await abortable(() => making, signal);
      if (!agent || typeof agent.send !== 'function' || typeof agent.close !== 'function') {
        throw new TypeError('makeAgent must return an Agent');
      }
    } catch (error) {
      // An Agent that arrives after the deadline or the abort is still closed, and the suite waits for it.
      if (!agent) {
        const late: Promise<void> = making
          .then(async built => { if (typeof built?.close === 'function') await built.close(); })
          .catch(() => undefined)
          .finally(() => options.lateCloses.delete(late));
        options.lateCloses.add(late);
      }
      return failed('make-agent', error);
    }
    const built = agent;
    const started = performance.now();
    let turn: Turn;
    try {
      turn = await abortable(() => built.send(task.input, { signal, timeoutMs: options.timeoutMs }), signal);
    } catch (error) {
      return failed('turn', error, { latencyMs: Math.round(performance.now() - started) });
    }
    const observed: Partial<AblationRun> = {
      status: turn.status,
      latencyMs: Math.round(performance.now() - started),
      ...usageOf(turn),
      ...memoryOf(turn),
    };
    try {
      const verdict = await abortable(() => task.check(turn), signal);
      if (typeof verdict !== 'boolean') throw new TypeError('check must return a boolean');
      return { ...base, passed: verdict, ...observed };
    } catch (error) {
      return failed('check', error, observed);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    const built = agent;
    if (typeof built?.close === 'function') await Promise.resolve().then(() => built.close()).catch(() => undefined);
  }
}

function usageOf(turn: Turn): { usage?: AblationUsage } {
  const usage = turn.usage;
  if (!usage || typeof usage !== 'object') return {};
  const picked: AblationUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reportedCostUsd'] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) picked[key] = value;
  }
  return { usage: picked };
}

/** The turn's memory note reduced to ids, sources and sizes; a failure reason is left out, it may quote a provider. */
function memoryOf(turn: Turn): { memory?: AblationMemoryNote } {
  const metadata = turn.providerMetadata;
  const note = metadata && typeof metadata === 'object' ? (metadata as { memory?: MemoryTurnNote }).memory : undefined;
  if (!note || typeof note !== 'object') return {};
  if (note.status === 'empty' || note.status === 'failed') return { memory: { status: note.status } };
  if (note.status !== 'recalled' || !Array.isArray(note.items)) return {};
  return {
    memory: {
      status: 'recalled',
      items: note.items.map(item => ({ id: String(item.id), source: String(item.source), bytes: Number(item.bytes) })),
      omitted: Number(note.omitted) || 0,
      bytes: Number(note.bytes) || 0,
    },
  };
}
