/**
 * Dynamic workflows: the per-run state and the `DynamicWorkflowContext` a script receives.
 *
 * Call keys. Every `agent()` call gets `key = sha256(canonical({ format: 1, prompt, options, occurrence }))`
 * where `options` are the validated options minus `label` (defaults filled: `permissions`, `isolation`)
 * and `occurrence` counts earlier calls of this exact (prompt, options) pair in the run. The key is
 * computed synchronously when `agent()` is called, so the same script with the same args produces the
 * same keys on resume, in call order, even under concurrency: only identical calls share an ordinal,
 * and identical calls are interchangeable. Two identical calls still get distinct keys.
 *
 * Determinism. The context offers no clock and no randomness. For resume to replay, a script must be
 * deterministic given its args and its agents' outputs (no Date.now(), Math.random() or external I/O in
 * the script; pass timestamps and seeds through `args`) — the same rule as Claude Code's workflows.
 */
import { canonical, checksum, freeze } from '../../shared/json.js';
import type { Usage } from '../../public/types.js';
import {
  DynamicSchemaCache, dynamicLabel, dynamicUsageError, resolveAgentOptions, strictJson, validatePrompt,
  type AgentOptionScope, type ResolvedAgentOptions, type ResolvedDynamicLimits,
} from './limits.js';
import {
  executeAgentCall, refusal, usageTokens, type AgentCall, type CallEnvironment, type DynamicLaunchGate,
} from './agent-call.js';
import { DynamicWindow, type DynamicClock } from './concurrency.js';
import type {
  DynamicAgentOptions, DynamicAgentResult, DynamicAgentRunner, DynamicIsolation, DynamicJournal,
  DynamicWorkflowContext, DynamicWorkflowEvent, DynamicWorkflowMeta, JsonValue,
} from './types.js';

export interface DynamicRunSetup {
  readonly runId: string;
  readonly meta: DynamicWorkflowMeta;
  readonly limits: ResolvedDynamicLimits;
  readonly runner: DynamicAgentRunner;
  readonly journal: DynamicJournal | undefined;
  readonly isolation: DynamicIsolation | undefined;
  readonly launch: DynamicLaunchGate | undefined;
  /** Time source of rate-limit backoff waits. */
  readonly clock: DynamicClock;
  /** Deep-frozen strict JSON. */
  readonly args: JsonValue;
  readonly signal: AbortSignal;
  readonly onEvent: ((event: DynamicWorkflowEvent) => void) | undefined;
  /** Records the first execution halt and aborts the run's signal with it. */
  readonly halt: (error: unknown) => void;
}

export type DynamicAgentSummary = Omit<DynamicAgentResult, 'output'>;

const LOG_MAX = 4096;

/** The options that identify a call (everything but the presentational label). */
function keyOptions(options: ResolvedAgentOptions): Omit<ResolvedAgentOptions, 'label'> {
  const { label: _label, ...rest } = options;
  return rest;
}

/** One run's mutable state; it is the `CallEnvironment` of every agent call of the run. */
export class DynamicRun implements CallEnvironment {
  readonly slots: DynamicWindow;
  readonly schemas = new DynamicSchemaCache();
  budgetExhausted = false;
  journalFailures = 0;
  #agents = 0;
  #spent = 0;
  #sequence = 0;
  #phase: string | undefined;
  readonly #scope: AgentOptionScope;
  readonly #occurrences = new Map<string, number>();
  readonly #labels = new Set<string>();
  readonly #summaries: Array<DynamicAgentSummary | undefined> = [];
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(readonly setup: DynamicRunSetup) {
    const { concurrency: ceiling, initialConcurrency } = setup.limits;
    this.slots = new DynamicWindow(ceiling, initialConcurrency, change => this.emit({
      type: 'concurrency.changed', runId: this.runId, ...change, ceiling, at: new Date().toISOString(),
    }));
    const declared = setup.meta.phases?.map(phase => phase.title);
    this.#scope = {
      limits: setup.limits,
      phases: declared === undefined ? undefined : new Set(declared),
      isolationConfigured: setup.isolation !== undefined,
      schemas: this.schemas,
    };
  }

  get runId() { return this.setup.runId; }
  get limits() { return this.setup.limits; }
  get runner() { return this.setup.runner; }
  get journal() { return this.setup.journal; }
  get isolation() { return this.setup.isolation; }
  get launch() { return this.setup.launch; }
  get clock() { return this.setup.clock; }
  get signal() { return this.setup.signal; }
  get spent() { return this.#spent; }
  get agentCount() { return this.#agents; }

  emit(event: DynamicWorkflowEvent): void {
    try { this.setup.onEvent?.(event); } catch { /* an observer's failure never changes the run */ }
  }

  /** Counts one more agent call (not attempt); false once `maxAgents` is reached. */
  reserveAgent(): boolean {
    if (this.#agents >= this.setup.limits.maxAgents) return false;
    this.#agents++;
    return true;
  }

  budgetLeft(): boolean {
    const total = this.setup.limits.tokens;
    if (total !== undefined && this.#spent >= total) { this.budgetExhausted = true; return false; }
    return true;
  }

  addUsage(usage: Usage | undefined): void {
    const tokens = usageTokens(usage);
    if (tokens <= 0) return;
    this.#spent += tokens;
    const total = this.setup.limits.tokens;
    this.emit({ type: 'budget', runId: this.runId, spent: this.#spent, ...(total === undefined ? {} : { total }), at: new Date().toISOString() });
  }

  journalFailed(): void { this.journalFailures++; }

  halt(error: unknown): void { this.setup.halt(error); }

  /** Finished calls in call order, without outputs. */
  summaries(): DynamicAgentSummary[] {
    return this.#summaries.filter((summary): summary is DynamicAgentSummary => summary !== undefined);
  }

  /** Waits until no agent call of the run is in flight (calls started meanwhile included). */
  async drain(): Promise<void> {
    while (this.#inFlight.size) await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * Validates, keys and starts one call. Everything up to `executeAgentCall` runs synchronously when
   * the script calls `agent()`, so keys, labels and the agent count follow the script's call order.
   */
  agentResult(prompt: string, options?: DynamicAgentOptions): Promise<DynamicAgentResult> {
    let call: AgentCall;
    let sequence: number;
    try {
      const text = validatePrompt(prompt);
      const resolved = resolveAgentOptions(options, this.#scope);
      if (resolved.label !== undefined && this.#labels.has(resolved.label)) {
        throw dynamicUsageError(`Agent label ${JSON.stringify(resolved.label)} is already used in this run`);
      }
      const identity = keyOptions(resolved);
      const pair = checksum(canonical({ options: identity, prompt: text }));
      const occurrence = this.#occurrences.get(pair) ?? 0;
      this.#occurrences.set(pair, occurrence + 1);
      if (resolved.label !== undefined) this.#labels.add(resolved.label);
      const key = checksum(canonical({ format: 1, occurrence, options: identity, prompt: text }));
      call = { key, prompt: text, options: resolved, phase: resolved.phase ?? this.#phase };
      sequence = this.#sequence++;
    } catch (error) { return Promise.reject(error); }
    let pending: Promise<DynamicAgentResult>;
    if (this.signal.aborted) {
      pending = Promise.resolve(refusal(call, 'skipped', 'ABORTED', 'The run was aborted before this agent call started'));
    } else if (!this.reserveAgent()) {
      pending = Promise.resolve(refusal(call, 'failed', 'LIMIT', `The run agent limit (${this.limits.maxAgents}) was reached`));
    } else {
      pending = executeAgentCall(this, call);
    }
    const settled = pending.then(result => {
      const { output: _output, ...summary } = result;
      const frozen = freeze(JSON.parse(JSON.stringify(summary)) as DynamicAgentSummary);
      this.#summaries[sequence] = frozen;
      this.emit({ type: 'agent.finished', runId: this.runId, result: frozen, at: new Date().toISOString() });
      return result;
    });
    this.#inFlight.add(settled);
    const remove = () => { this.#inFlight.delete(settled); };
    settled.then(remove, remove);
    return settled;
  }

  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>> {
    try {
      if (!Array.isArray(thunks)) throw dynamicUsageError('parallel expects an array of functions');
      this.#items(thunks.length, 'parallel');
      if (thunks.some(thunk => typeof thunk !== 'function')) throw dynamicUsageError('parallel expects an array of functions');
    } catch (error) { return Promise.reject(error); }
    // Thunks start synchronously in array order, so their agent calls are keyed in that order.
    return Promise.all(thunks.map(thunk => new Promise<T>(resolve => resolve(thunk())).then(value => value, () => null)));
  }

  pipeline<T>(items: readonly T[], stages: ReadonlyArray<(value: any, item: T, index: number) => Promise<unknown>>): Promise<JsonValue[]> {
    try {
      if (!Array.isArray(items)) throw dynamicUsageError('pipeline expects an array of items');
      this.#items(items.length, 'pipeline');
      if (stages.some(stage => typeof stage !== 'function')) throw dynamicUsageError('pipeline stages must be functions');
    } catch (error) { return Promise.reject(error); }
    // No barrier: each item runs its own chain; a throwing stage ends that item with null.
    return Promise.all(items.map((item, index) => (async () => {
      let value: unknown = item;
      for (const stage of stages) value = await stage(value, item, index);
      // Each item ends as JSON: a value that is not strict JSON is a failed item, like a throwing stage.
      return strictJson(value);
    })().catch((): JsonValue => null)));
  }

  phase(title: string): void {
    const value = dynamicLabel(title, 'Phase title');
    if (this.#scope.phases && !this.#scope.phases.has(value)) {
      throw dynamicUsageError(`Phase ${JSON.stringify(value)} is not declared in meta.phases`);
    }
    this.#phase = value;
    this.emit({ type: 'phase.started', runId: this.runId, title: value, at: new Date().toISOString() });
  }

  log(message: string): void {
    if (typeof message !== 'string') throw dynamicUsageError('log expects a string');
    this.emit({ type: 'log', runId: this.runId, message: message.slice(0, LOG_MAX), at: new Date().toISOString() });
  }

  #items(length: number, operation: string): void {
    if (length > this.limits.maxItems) {
      throw dynamicUsageError(`${operation} received ${length} items; the run limit is ${this.limits.maxItems} (never truncated)`);
    }
  }

  /** The frozen context handed to the script. */
  context(): DynamicWorkflowContext {
    const total = this.limits.tokens;
    const budget = Object.freeze({
      ...(total === undefined ? {} : { total }),
      spent: () => this.#spent,
      remaining: () => (total === undefined ? undefined : Math.max(0, total - this.#spent)),
    });
    return Object.freeze({
      runId: this.runId,
      args: this.setup.args,
      signal: this.signal,
      budget,
      agent: (prompt: string, options?: DynamicAgentOptions) => this.agentResult(prompt, options).then(result => result.output),
      agentResult: (prompt: string, options?: DynamicAgentOptions) => this.agentResult(prompt, options),
      parallel: <T>(thunks: ReadonlyArray<() => Promise<T>>) => this.parallel(thunks),
      pipeline: <T>(items: readonly T[], ...stages: ReadonlyArray<(value: any, item: T, index: number) => Promise<unknown>>) =>
        this.pipeline(items, stages),
      phase: (title: string) => this.phase(title),
      log: (message: string) => this.log(message),
    });
  }
}
