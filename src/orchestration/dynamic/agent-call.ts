/**
 * Dynamic workflows: executing one agent call (journal replay, concurrency window, budget, launch gate,
 * worktree isolation, per-attempt timeout, structured-output validation with bounded re-asks, rate-limit
 * retries with backoff).
 *
 * `executeAgentCall` never rejects: every failure becomes a `failed`/`skipped` result whose error is an
 * SDK-authored code and message (never provider text). Runners must settle promptly once their signal
 * aborts (the bundled runner stops its process): the engine awaits the runner so the concurrency slot,
 * the launch hold and the worktree inspection always follow the agent's real end.
 *
 * Attempts. A call is one `maxAgents` unit however many attempts it takes. A schema re-ask keeps its slot
 * (it follows at once). A RATE_LIMITED attempt cuts the window and, while `rateLimitRetries` remain,
 * releases its slot and launch hold, waits its backoff on the run's clock (abortable by the run signal)
 * and queues for a slot again; the retry is the same call (same key, same prompt and feedback).
 */
import type { ErrorObject, ValidateFunction } from 'ajv';
import { ExecutionHaltedError, isExecutionHalted } from '../../public/execution-halt.js';
import type { Usage } from '../../public/types.js';
import { rateLimitDelay, type DynamicClock, type DynamicWindow } from './concurrency.js';
import { strictJson, type DynamicSchemaCache, type ResolvedAgentOptions, type ResolvedDynamicLimits } from './limits.js';
import { DynamicRunnerError, dynamicRunnerMessage, isDynamicRunnerErrorCode } from './runner-error.js';
import type {
  DynamicAgentResult, DynamicAgentRunner, DynamicIsolation, DynamicJournal, DynamicWorkflowEvent, JsonValue,
} from './types.js';

/** A host-wide launch cap (for example an adapter over `SharedLaunchBudget`): held while an agent runs. */
export interface DynamicLaunchGate {
  acquire(signal: AbortSignal): Promise<{ release(): void | Promise<void> }>;
}

const NUMERIC = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens'] as const;
const MEANINGS: ReadonlyArray<Usage['costMeaning']> = ['provider-reported', 'api-equivalent', 'estimate', 'unavailable'];
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Keeps only well-formed usage numbers; anything malformed is dropped rather than trusted. */
export function sanitizeUsage(value: unknown): Usage | undefined {
  if (!plain(value)) return undefined;
  const meaning = MEANINGS.includes(value.costMeaning as Usage['costMeaning']) ? value.costMeaning as Usage['costMeaning'] : 'unavailable';
  const usage: Usage = { costMeaning: meaning };
  for (const field of NUMERIC) if (count(value[field])) usage[field] = value[field];
  if (meaning !== 'unavailable' && count(value.reportedCostUsd)) usage.reportedCostUsd = value.reportedCostUsd;
  if (plain(value.perModel)) {
    const perModel: NonNullable<Usage['perModel']> = {};
    for (const [model, entry] of Object.entries(value.perModel).slice(0, 64)) {
      if (!plain(entry)) continue;
      const fields: Record<string, number> = {};
      for (const field of [...NUMERIC, 'reportedCostUsd'] as const) if (count(entry[field])) fields[field] = entry[field];
      perModel[model.slice(0, 128)] = fields;
    }
    usage.perModel = perModel;
  }
  return usage;
}

/** Sums two attempts' usage; a mixed cost meaning becomes 'unavailable' (and its cost is dropped). */
export function mergeUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left || !right) return left ?? right;
  const meaning = left.costMeaning === right.costMeaning ? left.costMeaning : 'unavailable';
  const merged: Usage = { costMeaning: meaning };
  for (const field of NUMERIC) {
    if (left[field] !== undefined || right[field] !== undefined) merged[field] = (left[field] ?? 0) + (right[field] ?? 0);
  }
  if (meaning !== 'unavailable' && left.reportedCostUsd !== undefined && right.reportedCostUsd !== undefined) {
    merged.reportedCostUsd = left.reportedCostUsd + right.reportedCostUsd;
  }
  if (left.perModel || right.perModel) {
    const perModel: NonNullable<Usage['perModel']> = {};
    for (const source of [left.perModel ?? {}, right.perModel ?? {}]) {
      for (const [model, entry] of Object.entries(source)) {
        const target: Record<string, number> = { ...(perModel[model] as Record<string, number> | undefined) };
        for (const [field, value] of Object.entries(entry)) if (typeof value === 'number') target[field] = (target[field] ?? 0) + value;
        perModel[model] = target;
      }
    }
    merged.perModel = perModel;
  }
  return merged;
}

/** Tokens a usage spends against the budget: input + output as reported (cache counters are not added). */
export function usageTokens(usage: Usage | undefined): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

/** What one call needs from its run. */
export interface CallEnvironment {
  readonly runId: string;
  readonly limits: ResolvedDynamicLimits;
  readonly runner: DynamicAgentRunner;
  readonly journal: DynamicJournal | undefined;
  readonly isolation: DynamicIsolation | undefined;
  readonly launch: DynamicLaunchGate | undefined;
  /** The run's signal: aborted by the caller's signal or when the script fails. */
  readonly signal: AbortSignal;
  /** The run's adaptive concurrency window. */
  readonly slots: DynamicWindow;
  /** Time source of rate-limit backoff waits. */
  readonly clock: DynamicClock;
  readonly schemas: DynamicSchemaCache;
  /** False (and the run marked budget-exhausted) once spent ≥ the token budget. */
  budgetLeft(): boolean;
  addUsage(usage: Usage | undefined): void;
  journalFailed(): void;
  /** A failed infrastructure boundary: stops the run, aborts in-flight calls, and fails the run with it. */
  halt(error: unknown): void;
  emit(event: DynamicWorkflowEvent): void;
}

export interface AgentCall {
  readonly key: string;
  readonly prompt: string;
  readonly options: ResolvedAgentOptions;
  /** Explicit `options.phase`, else the script's current phase. */
  readonly phase: string | undefined;
}

type Worktree = NonNullable<DynamicAgentResult['worktree']>;
interface Extras { usage?: Usage | undefined; worktree?: Worktree | undefined; durationMs?: number }

export function refusal(call: AgentCall, status: 'failed' | 'skipped', code: string, message: string, extras: Extras = {}): DynamicAgentResult {
  return build(call, status, null, { code, message }, extras);
}

function build(call: AgentCall, status: DynamicAgentResult['status'], output: JsonValue,
  error: DynamicAgentResult['error'], extras: Extras): DynamicAgentResult {
  return {
    key: call.key,
    ...(call.options.label === undefined ? {} : { label: call.options.label }),
    status, output,
    ...(extras.usage === undefined ? {} : { usage: extras.usage }),
    durationMs: Math.max(0, extras.durationMs ?? 0),
    ...(extras.worktree === undefined ? {} : { worktree: extras.worktree }),
    ...(error === undefined ? {} : { error }),
    cached: false,
  };
}

const skipped = (call: AgentCall) => refusal(call, 'skipped', 'ABORTED', 'The run was aborted before this agent call started');
const now = () => new Date().toISOString();

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === 'string' && name !== 'Error' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? ` (${name})` : '';
}

interface RunnerFailure { code: string; message: string; usage: Usage | undefined; retryAt: number | undefined }

/** A runner's `DynamicRunnerError` with a closed code: its code is reported, its message rebuilt by the SDK. */
function runnerFailure(error: unknown): RunnerFailure | undefined {
  if (!(error instanceof DynamicRunnerError) || !isDynamicRunnerErrorCode(error.code)) return undefined;
  const retryAt: unknown = error.code === 'RATE_LIMITED' ? error.retryAt : undefined;
  return {
    code: error.code,
    message: `The agent run failed: ${dynamicRunnerMessage(error.code, error.runtimeCode)}`,
    usage: sanitizeUsage(error.usage),
    retryAt: Number.isSafeInteger(retryAt) ? retryAt as number : undefined,
  };
}

type LeaseRefusal = 'aborted' | 'budget' | 'launch';

/** A call's hold on a window slot and on the launch gate; given up while a rate-limited call backs off. */
class Lease {
  #held = false;
  #hold: { release(): void | Promise<void> } | undefined;
  constructor(private readonly env: CallEnvironment) {}

  get held(): boolean { return this.#held; }

  /** Takes a slot, checks the abort and the budget, then takes the launch gate; undefined when held. */
  async acquire(): Promise<LeaseRefusal | undefined> {
    const { env } = this;
    if (!(await env.slots.acquire(env.signal))) return 'aborted';
    const refused: LeaseRefusal | undefined = env.signal.aborted ? 'aborted' : !env.budgetLeft() ? 'budget' : undefined;
    if (refused) { env.slots.release(); return refused; }
    if (env.launch) {
      try { this.#hold = await env.launch.acquire(env.signal); }
      catch (error) {
        if (isExecutionHalted(error)) env.halt(error);
        env.slots.release();
        return env.signal.aborted ? 'aborted' : 'launch';
      }
    }
    this.#held = true;
    // Admission can settle after the caller aborted or another attempt spent the budget.
    if (env.signal.aborted || !env.budgetLeft()) {
      await this.release();
      return env.signal.aborted ? 'aborted' : 'budget';
    }
    return undefined;
  }

  async release(): Promise<boolean> {
    if (!this.#held) return true;
    this.#held = false;
    const hold = this.#hold;
    this.#hold = undefined;
    try { await hold?.release(); }
    catch (error) {
      this.env.halt(isExecutionHalted(error) ? error : new ExecutionHaltedError({
        sanitizedDiagnostics: { reason: 'LAUNCH_RELEASE_FAILED' },
      }, { cause: error }));
      return false;
    } finally { this.env.slots.release(); }
    return true;
  }
}

/** Runs (or replays) one call; never rejects. */
export async function executeAgentCall(env: CallEnvironment, call: AgentCall): Promise<DynamicAgentResult> {
  try { return await execute(env, call); }
  catch (error) {
    if (isExecutionHalted(error)) {
      env.halt(error);
      return refusal(call, 'failed', 'ABORTED', 'Execution halted at an infrastructure boundary');
    }
    return refusal(call, 'failed', 'INTERNAL', 'The engine failed while running the agent call');
  }
}

async function execute(env: CallEnvironment, call: AgentCall): Promise<DynamicAgentResult> {
  if (env.journal) {
    let cached: DynamicAgentResult | undefined;
    try { cached = await env.journal.get(env.runId, call.key); }
    catch (error) { if (isExecutionHalted(error)) env.halt(error); env.journalFailed(); return refusal(call, 'failed', 'JOURNAL', 'The journal could not be read'); }
    if (cached && cached.key === call.key && cached.status === 'completed') {
      env.addUsage(cached.usage);
      const { label: _label, ...rest } = cached;
      return { ...rest, ...(call.options.label === undefined ? {} : { label: call.options.label }), cached: true };
    }
  }
  const lease = new Lease(env);
  try {
    const refused = await lease.acquire();
    if (refused === 'aborted') return skipped(call);
    if (refused === 'budget') return refusal(call, 'failed', 'BUDGET', 'The run token budget is spent');
    if (refused === 'launch') return refusal(call, 'failed', 'LAUNCH', 'The launch gate refused the agent call');
    const result = await live(env, call, lease);
    // Do not cache success if ownership could not be settled.
    if (!await lease.release()) return { ...result, status: 'failed', output: null,
      error: { code: 'ABORTED', message: 'Execution halted at an infrastructure boundary' } };
    if (result.status !== 'completed' || !env.journal) return result;
    try { await env.journal.put(env.runId, result); return result; }
    catch (error) {
      if (isExecutionHalted(error)) env.halt(error);
      env.journalFailed();
      return { ...result, status: 'failed', output: null, error: { code: 'JOURNAL', message: 'The journal could not record the agent result' } };
    }
  } finally { await lease.release(); }
}

async function live(env: CallEnvironment, call: AgentCall, lease: Lease): Promise<DynamicAgentResult> {
  const started = Date.now();
  const { label, phase } = { label: call.options.label, phase: call.phase };
  env.emit({ type: 'agent.started', runId: env.runId, key: call.key, ...(label === undefined ? {} : { label }),
    ...(phase === undefined ? {} : { phase }), at: now() });
  let tree: { path: string; branch: string } | undefined;
  if (call.options.isolation === 'worktree') {
    try {
      const created: unknown = await env.isolation!.create({ runId: env.runId, key: call.key, ...(label === undefined ? {} : { label }), signal: env.signal });
      if (!plain(created) || typeof created.path !== 'string' || !created.path || typeof created.branch !== 'string' || !created.branch) {
        throw new TypeError('Invalid worktree');
      }
      tree = { path: created.path, branch: created.branch };
    } catch (error) {
      if (isExecutionHalted(error)) env.halt(error);
      return env.signal.aborted ? skipped(call)
        : refusal(call, 'failed', 'ISOLATION', 'The agent worktree could not be created', { durationMs: Date.now() - started });
    }
  }
  const outcome = await attempts(env, call, tree?.path, lease);
  let worktree: Worktree | undefined;
  let failure = outcome.failure;
  if (tree) {
    try {
      const inspected: unknown = await env.isolation!.inspect(tree);
      if (!plain(inspected) || typeof inspected.changed !== 'boolean') throw new TypeError('Invalid inspection');
      worktree = { ...tree, changed: inspected.changed };
    } catch (error) {
      if (isExecutionHalted(error)) {
        env.halt(error);
        return refusal(call, 'failed', 'ABORTED', 'Execution halted at an infrastructure boundary', { usage: outcome.usage });
      }
      // Conservative: an uninspectable worktree is reported as changed so it is never discarded unseen.
      worktree = { ...tree, changed: true };
      failure ??= { code: 'ISOLATION', message: 'The agent worktree could not be inspected' };
    }
  }
  const extras: Extras = { usage: outcome.usage, worktree, durationMs: Date.now() - started };
  return failure ? refusal(call, 'failed', failure.code, failure.message, extras) : build(call, 'completed', outcome.output, undefined, extras);
}

interface Outcome { output: JsonValue; usage: Usage | undefined; failure?: { code: string; message: string } }

const LEASE_FAILURES: Readonly<Record<LeaseRefusal, readonly [string, string]>> = Object.freeze({
  aborted: ['ABORTED', 'The run was aborted while the call waited to retry after a rate limit'],
  budget: ['BUDGET', 'The run token budget was spent before a rate-limit retry'],
  launch: ['LAUNCH', 'The launch gate refused a rate-limit retry'],
});

async function attempts(env: CallEnvironment, call: AgentCall, cwd: string | undefined, lease: Lease): Promise<Outcome> {
  const { options } = call;
  const timeoutMs = options.timeoutMs ?? env.limits.agentTimeoutMs;
  const validate = options.schema === undefined ? undefined : env.schemas.compile(options.schema);
  const request = {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(call.phase === undefined ? {} : { phase: call.phase }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    permissions: options.permissions, isolation: options.isolation, timeoutMs,
  };
  let usage: Usage | undefined;
  let feedback = '';
  let rateRetries = 0;
  const fail = (code: string, message: string): Outcome => ({ output: null, usage, failure: { code, message } });
  for (let attempt = 0; ;) {
    if (!lease.held) {
      // Back from a rate-limit backoff: queue for a slot again (the abort and budget are checked there).
      const refused = await lease.acquire();
      if (refused) return fail(...LEASE_FAILURES[refused]);
    }
    // Checked synchronously right before every runner invocation: once spent reaches the budget, nothing
    // starts (the asynchronous slot and gate waits above can let another call's usage land meanwhile).
    const retry = attempt > 0 || rateRetries > 0;
    if (env.signal.aborted) return fail('ABORTED', retry ? 'The run was aborted before a retry' : 'The agent call was aborted');
    if (!env.budgetLeft()) return fail('BUDGET', retry ? 'The run token budget was spent before a retry' : 'The run token budget is spent');
    const epoch = env.slots.epoch;
    const deadline = performance.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Agent call timed out')), timeoutMs);
    let response: unknown;
    let problems: string[] | undefined;
    let limited: RunnerFailure | undefined;
    try {
      response = await env.runner.run({
        runId: env.runId, key: call.key, prompt: call.prompt + feedback, options: request,
        ...(cwd === undefined ? {} : { cwd }), signal: AbortSignal.any([env.signal, timeout.signal]),
      });
    } catch (error) {
      const failure = runnerFailure(error);
      // A failed turn still spent what the provider reported: it counts against the budget.
      usage = mergeUsage(usage, failure?.usage);
      env.addUsage(failure?.usage);
      // A halt is not a provider failure: it must stop this run, not be retried or reported as an answer.
      if (isExecutionHalted(error)) { env.halt(error); return fail('ABORTED', 'Execution halted at an infrastructure boundary'); }
      if (env.signal.aborted) return fail('ABORTED', 'The agent call was aborted');
      if (timeout.signal.aborted || performance.now() >= deadline) return fail('TIMEOUT', `The agent call exceeded its ${timeoutMs} ms timeout`);
      if (!failure) return fail('AGENT_ERROR', `The agent run failed${errorName(error)}`);
      if (failure.code === 'RATE_LIMITED') limited = failure;
      // Missing or non-JSON structured output is a schema failure: re-asked like a mismatch.
      else if (!validate || failure.code !== 'OUTPUT_INVALID') return fail(failure.code, failure.message);
      else problems = ['the answer was missing or was not valid JSON'];
    } finally { clearTimeout(timer); }
    if (limited) {
      env.slots.rateLimited(epoch);
      if (rateRetries >= env.limits.rateLimitRetries) {
        return fail('RATE_LIMITED', `${limited.message}; ${rateRetries + 1} rate-limited attempt(s)`);
      }
      const delay = rateLimitDelay(call.key, rateRetries, limited.retryAt, env.clock.now(), timeoutMs);
      if (delay === undefined) {
        return fail('RATE_LIMITED', `${limited.message}; the provider's reset is beyond the call's ${timeoutMs} ms timeout`);
      }
      if (!await lease.release() || env.signal.aborted) return fail(...LEASE_FAILURES.aborted);
      try { await env.clock.sleep(delay, env.signal); }
      catch (error) { if (isExecutionHalted(error)) env.halt(error); }
      if (env.signal.aborted) return fail(...LEASE_FAILURES.aborted);
      rateRetries++;
      continue;
    }
    if (problems === undefined) {
      const reported = plain(response) ? sanitizeUsage(response.usage) : undefined;
      usage = mergeUsage(usage, reported);
      env.addUsage(reported);
      if (env.signal.aborted) return fail(...LEASE_FAILURES.aborted);
      if (timeout.signal.aborted || performance.now() >= deadline) return fail('TIMEOUT', `The agent call exceeded its ${timeoutMs} ms timeout`);
      env.slots.succeeded(epoch);
      if (!plain(response) || typeof response.text !== 'string') return fail('INVALID_OUTPUT', 'The agent runner returned no turn text');
      if (!validate) return { output: response.text, usage };
      const checked = check(validate, response.output, response.text);
      if ('output' in checked) return { output: checked.output, usage };
      if ('failure' in checked) return fail('INVALID_OUTPUT', checked.failure);
      problems = checked.problems;
    }
    if (attempt >= env.limits.schemaRetries) {
      return fail('SCHEMA', `The structured output did not match the schema after ${attempt + 1} attempt(s)`);
    }
    feedback = [
      '', '', `[Structured output check] Your previous answer (attempt ${attempt + 1} of ${env.limits.schemaRetries + 1}) did not match the required JSON Schema:`,
      ...problems.map(problem => `- ${problem}`),
      'Answer again with a single JSON value that matches the schema.',
    ].join('\n');
    attempt++;
  }
}

/** Validates a turn's structured output (or, when the runner gave none, its text parsed as JSON). */
function check(validate: ValidateFunction, output: unknown, text: string): { output: JsonValue } | { problems: string[] } | { failure: string } {
  let candidate: JsonValue;
  if (output !== undefined) {
    try { candidate = strictJson(output); }
    catch { return { failure: 'The agent runner returned structured output that is not JSON' }; }
  } else {
    try { candidate = JSON.parse(text) as JsonValue; } catch { return { problems: ['the answer was not valid JSON'] }; }
  }
  return validate(candidate) ? { output: candidate } : { problems: describe(validate.errors) };
}

/** At most 10 schema errors, each at most 200 characters. */
function describe(errors: ErrorObject[] | null | undefined): string[] {
  const lines = (errors ?? []).slice(0, 10).map(error => `${(error.instancePath || '/').slice(0, 100)} ${error.message ?? 'is invalid'}`.slice(0, 200));
  if ((errors?.length ?? 0) > 10) lines.push(`(${errors!.length - 10} more)`);
  return lines.length ? lines : ['the answer did not match the schema'];
}
