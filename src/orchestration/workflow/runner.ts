import { checksum, cloneSteps, identity, jsonClone, nonempty, validateCheckpoint } from './checkpoint.js';
import { isExecutionHalted } from '../../public/execution-halt.js';
import { dependencyWaves } from './graph.js';
import type {
  JsonValue, WorkflowCheckpoint, WorkflowDefinition, WorkflowLease, WorkflowRearmOptions, WorkflowRearmResult,
  WorkflowRunOptions, WorkflowStep, WorkflowStore,
} from './types.js';

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === 'string' ? error.message : String(error);
  } catch { return 'Workflow callback failed with an unprintable error'; }
}
function preserveHalt(primary: unknown, secondary: unknown): unknown {
  return isExecutionHalted(primary) || isExecutionHalted(secondary)
    ? new AggregateError([primary, secondary], 'Execution halted during workflow cleanup', { cause: primary }) : secondary;
}

/** Executes finite dependency waves, holding a single durable run lease through all active work. */
export class WorkflowRunner {
  constructor(private readonly store: WorkflowStore) {}

  async run(input: WorkflowDefinition, options: WorkflowRunOptions): Promise<WorkflowCheckpoint> {
    options = { ...options };
    nonempty(options.runId, 'Run id');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('Invalid AbortSignal');
    const concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
    if (options.recoverInterrupted !== undefined && options.recoverInterrupted !== 'replay-safe') {
      throw new Error('Invalid interrupted recovery mode');
    }
    const definition = { ...input, steps: cloneSteps(input.steps) };
    const waves = dependencyWaves(definition.steps);
    const workflow = identity(definition);
    const lease = await this.store.acquire(options.runId);
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    let failed = false, failure: unknown;
    try {
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const loaded = await lease.load();
      const checkpoint: WorkflowCheckpoint = loaded === undefined ? {
        format: 1, runId: options.runId, workflow, status: 'running',
        steps: Object.fromEntries(definition.steps.map(step => [step.id, { status: 'pending', attempts: 0 }])),
      } : validateCheckpoint(loaded, definition, options.runId);
      const execution = new Execution(definition, checkpoint, lease, controller, options);
      return await execution.run(waves, concurrency);
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      // Execution drains all workers even if a save fails; ownership must outlive callbacks.
      let cleanupFailed = false, cleanupFailure: unknown;
      try { options.signal?.removeEventListener('abort', cancel); } catch (error) { cleanupFailed = true; cleanupFailure = error; }
      try { await lease.release(); } catch (error) { cleanupFailure = cleanupFailed ? preserveHalt(cleanupFailure, error) : error; cleanupFailed = true; }
      if (cleanupFailed) throw failed ? preserveHalt(failure, cleanupFailure) : cleanupFailure;
    }
  }

  /**
   * Resets non-completed steps to pending with zero attempts, under the run lease, so a later `run`
   * executes them again. This is the sanctioned way to spend a new attempt after a cooperative
   * cancellation or an exhausted `maxAttempts`; it never touches completed outputs, and the
   * blocked steps that (transitively) depend on a re-armed step are re-armed with it. The
   * acknowledgement is the caller's explicit statement that repeating the work is acceptable.
   */
  async rearm(input: WorkflowDefinition, options: WorkflowRearmOptions): Promise<WorkflowRearmResult> {
    nonempty(options?.runId, 'Run id');
    if (options.acknowledgement?.workStopped !== true) throw new Error('Explicitly acknowledge that the run\'s work has stopped before re-arming it');
    const selection = options.steps;
    if (selection !== 'incomplete' && (!Array.isArray(selection) || selection.length === 0 || selection.some(id => typeof id !== 'string'))) {
      throw new Error('Re-arm steps must be \'incomplete\' or a nonempty list of step ids');
    }
    const definition = { ...input, steps: cloneSteps(input.steps) };
    identity(definition);
    const lease = await this.store.acquire(options.runId);
    let failed = false, failure: unknown;
    try {
      const loaded = await lease.load();
      if (loaded === undefined) throw new Error(`No checkpoint exists for run ${options.runId}`);
      const checkpoint = validateCheckpoint(loaded, definition, options.runId);
      const ids = selection === 'incomplete'
        ? definition.steps.map(step => step.id).filter(id => checkpoint.steps[id]!.status !== 'completed')
        : [...new Set(selection)];
      const rearmed: WorkflowRearmResult['rearmed'] = [];
      for (const stepId of ids) {
        if (!definition.steps.some(step => step.id === stepId)) throw new Error(`Unknown step ${stepId}`);
        const state = checkpoint.steps[stepId]!;
        if (state.status === 'completed') throw new Error(`Step ${stepId} is completed; its output is never re-armed`);
        // Already re-armed (pending, no attempt, no error): nothing to report or rewrite.
        if (state.status === 'pending' && state.attempts === 0 && state.error === undefined) continue;
        rearmed.push({ stepId, status: state.status, attempts: state.attempts });
        checkpoint.steps[stepId] = { status: 'pending', attempts: 0 };
      }
      // A dependant blocked on a re-armed step would otherwise stay blocked forever: the run only
      // schedules pending steps. Blocked steps never ran, so re-arming them repeats no work.
      for (let grew = rearmed.length > 0; grew;) {
        grew = false;
        const armed = new Set(rearmed.map(item => item.stepId));
        for (const step of definition.steps) {
          const state = checkpoint.steps[step.id]!;
          if (armed.has(step.id) || state.status !== 'blocked' || !(step.dependencies ?? []).some(id => armed.has(id))) continue;
          rearmed.push({ stepId: step.id, status: state.status, attempts: state.attempts });
          checkpoint.steps[step.id] = { status: 'pending', attempts: 0 };
          armed.add(step.id); grew = true;
        }
      }
      if (rearmed.length === 0) return { checkpoint, rearmed };
      checkpoint.status = 'halted';
      await lease.save(validateCheckpoint(checkpoint, definition, options.runId));
      return { checkpoint: jsonClone(checkpoint), rearmed };
    } catch (error) { failed = true; failure = error; throw error; }
    finally { try { await lease.release(); } catch (error) { throw failed ? preserveHalt(failure, error) : error; } }
  }
}

/** The checkpoint only ever holds values already validated by jsonClone or validateCheckpoint. */
const snapshotOf = (checkpoint: WorkflowCheckpoint): WorkflowCheckpoint => JSON.parse(JSON.stringify(checkpoint)) as WorkflowCheckpoint;

class Execution {
  private writes: Promise<void> = Promise.resolve();
  private scheduled: Promise<void> | undefined;
  private persistenceFailure: unknown;
  private failedToPersist = false;

  constructor(
    private readonly definition: WorkflowDefinition,
    private readonly checkpoint: WorkflowCheckpoint,
    private readonly lease: WorkflowLease,
    private readonly controller: AbortController,
    private readonly options: WorkflowRunOptions,
  ) {}

  /**
   * Group commit: a caller arriving while a write is queued but has not yet taken its snapshot
   * joins that write. The snapshot is taken when the write starts, so it includes every mutation
   * made before each joiner's call, and every caller resolves only once a snapshot taken at or
   * after its call is durable. Writes stay serialized; attempts stay consumed before execute.
   */
  private async persist(): Promise<void> {
    if (this.failedToPersist) throw this.persistenceFailure;
    if (!this.scheduled) {
      const write = this.writes.then(() => {
        this.scheduled = undefined;
        if (this.failedToPersist) throw this.persistenceFailure;
        return this.lease.save(snapshotOf(this.checkpoint));
      });
      this.scheduled = write;
      // Keep the internal chain handled; each caller still observes its own rejection.
      this.writes = write.catch(error => {
        this.failedToPersist = true;
        this.persistenceFailure = error;
        this.controller.abort(error);
      });
    }
    await this.scheduled;
    if (this.failedToPersist) throw this.persistenceFailure;
  }

  async run(waves: WorkflowStep[][], concurrency: number): Promise<WorkflowCheckpoint> {
    // A completed run is read back as is: there is nothing to schedule and nothing to write.
    if (this.checkpoint.status === 'completed') return jsonClone(this.checkpoint);
    const ambiguous = this.definition.steps.filter(step => ['running', 'interrupted'].includes(this.checkpoint.steps[step.id]!.status));
    if (ambiguous.some(step => !step.replaySafe || this.options.recoverInterrupted !== 'replay-safe')) {
      this.checkpoint.status = 'halted';
      await this.persist();
      return jsonClone(this.checkpoint);
    }
    for (const step of ambiguous) {
      const state = this.checkpoint.steps[step.id]!;
      state.status = state.attempts >= (step.maxAttempts ?? 1) ? 'failed' : 'pending';
      state.error = 'Previous execution was interrupted; its attempt remains consumed';
    }
    this.checkpoint.status = 'running';
    await this.persist();
    for (const wave of waves) {
      if (this.controller.signal.aborted) break;
      const queue: WorkflowStep[] = []; let blocked = false;
      for (const step of wave) {
        const state = this.checkpoint.steps[step.id]!;
        if (state.status !== 'pending') continue;
        if ((step.dependencies ?? []).some(id => this.checkpoint.steps[id]!.status !== 'completed')) {
          state.status = 'blocked'; state.error = 'A dependency did not complete'; blocked = true;
        } else queue.push(step);
      }
      // The wave snapshot only differs from the last one when a dependant was blocked.
      if (blocked) await this.persist();
      let cursor = 0;
      const worker = async () => {
        while (!this.controller.signal.aborted) {
          const step = queue[cursor++];
          if (!step) break;
          await this.execute(step);
        }
      };
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, worker);
      const settled = await Promise.allSettled(workers);
      const halted = settled.find(result => result.status === 'rejected' && isExecutionHalted(result.reason));
      if (this.failedToPersist) throw halted?.status === 'rejected' ? preserveHalt(halted.reason, this.persistenceFailure) : this.persistenceFailure;
      if (halted?.status === 'rejected') throw halted.reason;
      const rejected = settled.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    }
    const states = Object.values(this.checkpoint.steps);
    // 'failed' is terminal only when a step failed and nothing is left to run; any other
    // unfinished shape (e.g. a dependant still blocked on a re-armed step) halts for a re-arm.
    const failed = states.some(state => state.status === 'failed')
      && !states.some(state => ['pending', 'running', 'interrupted'].includes(state.status));
    this.checkpoint.status = states.every(state => state.status === 'completed') ? 'completed'
      : this.controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'halted';
    await this.persist();
    return jsonClone(this.checkpoint);
  }

  private async execute(step: WorkflowStep): Promise<void> {
    const state = this.checkpoint.steps[step.id]!;
    const max = step.maxAttempts ?? 1;
    while (state.attempts < max && !this.controller.signal.aborted) {
      state.attempts++;
      state.status = 'running';
      delete state.error;
      await this.persist();
      if (this.controller.signal.aborted) {
        // Cancellation during the pre-call save has not invoked the callback.
        state.attempts--; state.status = 'pending';
        await this.persist();
        return;
      }
      let output: JsonValue;
      try {
        const dependencyOutputs = Object.fromEntries((step.dependencies ?? []).map(id =>
          [id, jsonClone(this.checkpoint.steps[id]!.output!)]));
        output = jsonClone(await step.execute({
          runId: this.options.runId, stepId: step.id, attempt: state.attempts,
          idempotencyKey: `oar-workflow:${checksum(JSON.stringify([
            this.options.runId, this.checkpoint.workflow.fingerprint, step.id,
          ]))}`,
          dependencyOutputs, signal: this.controller.signal,
        }));
      } catch (error) {
        const halted = isExecutionHalted(error);
        if (halted) this.controller.abort(error);
        state.error = halted ? 'Execution halted; owner reconciliation required' : errorMessage(error);
        state.status = this.controller.signal.aborted ? 'interrupted' : state.attempts >= max ? 'failed' : 'pending';
        try { await this.persist(); } catch (secondary) { throw preserveHalt(error, secondary); }
        if (halted) throw error;
        if (state.status !== 'pending') return;
        continue;
      }
      state.status = 'completed'; state.output = output;
      await this.persist();
      return;
    }
  }
}
