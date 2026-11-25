import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { freeze, method, object } from '../../shared/json.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../public/execution-halt.js';
import type { AgentEvent, Usage } from '../../public/types.js';
import type { LogCommit, LogJsonValue, LogReceipt, RunIdentity } from './types.js';
import { AGENT_METADATA_SCHEMA, CAPTURE_OPERATION_SCHEMA, boundedInteger, captureActual, captureAgentEvent, captureIdentity, captureReceipt, captureSessionBinding, decodeCaptureMetadata, safeUsage } from './capture-codec.js';
import { captureLogCommit } from './validation.js';
import { awaitCaptureWrite, captureWriteOptions } from './capture-writes.js';
export interface RequiredLogCaptureOptions {
  readonly store: { append(commit: LogCommit): Promise<LogReceipt> }; readonly identity: RunIdentity;
  readonly actual: { readonly provider: string; readonly model?: string; readonly attemptId: string; readonly transport?: 'exec' | 'control'; readonly phase?: 'startup' | 'turn'; readonly sessionId?: string; readonly transportEpoch?: string }; readonly maxPending?: number;
  readonly maxWriteMs?: number; readonly signal?: AbortSignal;
}
export interface RequiredLogCapture {
  run<T>(work: () => Promise<T>): Promise<T>; observe(event: AgentEvent): Promise<LogReceipt>; drain(): Promise<void>;
  recordUsage(usage: Usage): void; markInterrupted(): void;
  readonly signal: AbortSignal;
  snapshot(): Readonly<{ state: 'idle' | 'starting' | 'running' | 'draining' | 'settled' | 'halted'; pending: number; maxPending: number; mode: 'metadata-only'; textReconstruction: 'unavailable' }>;
}
/** Awaited capture boundary. Completion means only this observed invocation settled, never a business postcondition. */
export function createRequiredLogCapture(options: RequiredLogCaptureOptions): RequiredLogCapture {
  object(options, ['store', 'identity', 'actual', 'maxPending', 'maxWriteMs', 'signal']); const { maxWriteMs, signal } = captureWriteOptions(options);
  const identity = captureIdentity(options.identity), actual = captureActual(options.actual), maxPending = boundedInteger(options.maxPending ?? 2, 1, 64);
  const append = method<(commit: LogCommit) => Promise<LogReceipt>>(options.store, 'append');
  const invocationDigest = randomBytes(32).toString('hex'), controller = new AbortController();
  const pending = new Set<Promise<LogReceipt>>(); let state: 'idle' | 'starting' | 'running' | 'draining' | 'settled' | 'halted' = 'idle';
  let failure: ExecutionHaltedError | undefined, usage: Usage | undefined, sourceId: string | undefined, interrupted = false;
  function halt(cause: unknown): ExecutionHaltedError {
    if (!failure) { failure = new ExecutionHaltedError({ ...(usage ? { observedUsage: usage } : {}) }, { cause }); state = 'halted'; controller.abort(failure); }
    return failure;
  }
  function write(schema: string, type: string, metadata: unknown): Promise<LogReceipt> {
    if (failure) return observedRejection(failure);
    if (pending.size >= maxPending) return observedRejection(halt(Error('CAPTURE_CAPACITY')));
    let operation: Promise<LogReceipt>;
    try {
      decodeCaptureMetadata(schema, type, metadata);
      const commit = captureLogCommit({ requestId: randomBytes(24).toString('hex'), records: [{ identity, schema: { id: schema, version: 1 }, type, causal: [], payload: { inline: metadata as LogJsonValue } }] });
      operation = Promise.resolve(append(commit));
    } catch (error) { return observedRejection(halt(error)); }
    const tracked = operation.then(value => { const receipt = captureReceipt(value, sourceId); sourceId = receipt.head.sourceId; return receipt; }).catch(error => { throw halt(error); }); pending.add(tracked);
    void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked));
    return awaitCaptureWrite(tracked, maxWriteMs, state === 'draining' ? undefined : signal, halt);
  }
  function observedRejection(error: unknown): Promise<never> { const promise = Promise.reject(error); void promise.catch(() => {}); return promise; }
  async function drain(): Promise<void> {
    if (failure) throw failure;
    while (pending.size) await awaitCaptureWrite(Promise.allSettled([...pending]), maxWriteMs, undefined, halt);
    if (failure) throw failure;
  }
  function observe(event: AgentEvent): Promise<LogReceipt> {
    if (state !== 'running' || failure) return observedRejection(failure ?? halt(Error('CAPTURE_NOT_RUNNING')));
    try {
      const projected = captureAgentEvent(event); if (projected.usage) usage = projected.usage;
      const sessionBinding = captureSessionBinding(event);
      return write(AGENT_METADATA_SCHEMA, projected.type, freeze({ mode: 'metadata-only', invocationDigest, actual, event: projected, ...(sessionBinding ? { sessionBinding } : {}) }));
    } catch (error) { return observedRejection(halt(error)); }
  }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    if (state !== 'idle' || typeof work !== 'function' || types.isProxy(work)) throw failure ?? halt(Error('CAPTURE_ALREADY_USED'));
    state = 'starting';
    await write(CAPTURE_OPERATION_SCHEMA, 'capture.started', freeze({ mode: 'metadata-only', invocationDigest, actual, stage: 'started' }));
    if (failure) throw failure; state = 'running';
    let result: T | undefined, original: unknown, failed = false;
    try { result = await work(); } catch (error) { original = error; failed = true; const observed = errorUsage(error); if (observed) usage = observed; }
    if (!failure) state = 'draining'; let secondary: unknown;
    try {
      await drain();
      const stage = interrupted ? 'interrupted' : 'settled';
      await write(CAPTURE_OPERATION_SCHEMA, `capture.${stage}`, freeze({ mode: 'metadata-only', invocationDigest, actual, stage, outcome: failed ? isExecutionHalted(original) ? 'halted' : 'failed' : 'returned', ...(usage ? { usage } : {}) }));
    } catch (error) { secondary = error; }
    if (!secondary) state = 'settled';
    if (failed) {
      if (secondary && !isExecutionHalted(original)) throw new ExecutionHaltedError({ ...(usage ? { observedUsage: usage } : {}) }, { cause: original });
      throw original;
    }
    if (secondary) throw secondary; state = 'settled'; return result as T;
  }
  return Object.freeze({ run, observe, drain, recordUsage: (input: Usage) => { usage = safeUsage(input); }, markInterrupted: () => { interrupted = true; }, signal: controller.signal,
    snapshot: () => freeze({ state, pending: pending.size, maxPending, mode: 'metadata-only' as const, textReconstruction: 'unavailable' as const }) });
}
function errorUsage(error: unknown): Usage | undefined {
  const pending = [{ value: error, depth: 0 }], seen = new Set<object>();
  while (pending.length && seen.size < 64) {
    const { value, depth } = pending.shift()!;
    if (!value || typeof value !== 'object' || types.isProxy(value) || !types.isNativeError(value) || seen.has(value) || depth >= 16) continue; seen.add(value);
    const context = Object.getOwnPropertyDescriptor(value, 'context');
    if (context && Object.hasOwn(context, 'value') && context.value && typeof context.value === 'object' && !types.isProxy(context.value)) {
      const observed = Object.getOwnPropertyDescriptor(context.value, 'observedUsage');
      if (observed && Object.hasOwn(observed, 'value')) try { return safeUsage(observed.value); } catch { /* Unknown usage remains absent. */ }
    }
    const cause = Object.getOwnPropertyDescriptor(value, 'cause'); if (cause && Object.hasOwn(cause, 'value')) pending.push({ value: cause.value, depth: depth + 1 });
    const errors = Object.getOwnPropertyDescriptor(value, 'errors');
    if (errors && Object.hasOwn(errors, 'value') && !types.isProxy(errors.value) && Array.isArray(errors.value) && errors.value.length <= 64 - pending.length) {
      for (let i = 0; i < errors.value.length; i++) { const item = Object.getOwnPropertyDescriptor(errors.value, String(i)); if (item && Object.hasOwn(item, 'value')) pending.push({ value: item.value, depth: depth + 1 }); }
    }
  }
  return undefined;
}
