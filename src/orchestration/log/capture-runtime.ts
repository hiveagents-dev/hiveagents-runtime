import { randomUUID } from 'node:crypto';
import { freeze, method, object } from '../../shared/json.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../public/execution-halt.js';
import type { ModelInfo, SessionIdentity, TransportKind } from '../../public/types.js';
import type { LogCommit, LogReceipt, RunIdentity } from './types.js';
import { boundedInteger, captureIdentity } from './capture-codec.js';
import { createRequiredLogCapture, type RequiredLogCapture } from './capture.js';
export interface RuntimeCaptureOptions {
  readonly store: { append(commit: LogCommit): Promise<LogReceipt> }; readonly identity: RunIdentity;
  readonly maxPending?: number; readonly maxWriteMs?: number;
}
export interface AgentLogCaptureBinding {
  readonly identity: RunIdentity;
  assertActive(): void;
  create(model: ModelInfo, transport: TransportKind, phase: 'startup' | 'turn', signal?: AbortSignal, session?: SessionIdentity): RequiredLogCapture;
}
/** Trusted optional composition. Ledger/capture records grant no model/native/effect permission. */
export function createRuntimeCapture(options: RuntimeCaptureOptions) {
  object(options, ['store', 'identity', 'maxPending', 'maxWriteMs']);
  const base = captureIdentity(options.identity), maxPending = boundedInteger(options.maxPending ?? 2, 1, 64), maxWriteMs = boundedInteger(options.maxWriteMs ?? 5000, 1, 30000);
  const append = method<(commit: LogCommit) => Promise<LogReceipt>>(options.store, 'append');
  let pending = 0, failure: unknown; const stopped = new AbortController();
  const fail = (cause: unknown) => { if (!failure) { failure = isExecutionHalted(cause) ? cause : new ExecutionHaltedError({}, { cause }); stopped.abort(failure); } return failure; };
  const store = Object.freeze({ append(commit: LogCommit): Promise<LogReceipt> {
    if (failure) return Promise.reject(failure);
    if (pending >= maxPending) return Promise.reject(fail(Error('CAPTURE_CAPACITY')));
    pending++;
    let work: Promise<LogReceipt>;
    try { work = Promise.resolve(append(commit)); } catch (error) { pending--; return Promise.reject(fail(error)); }
    return work.then(receipt => receipt, error => { throw fail(error); }).finally(() => { pending--; });
  } });
  return Object.freeze({ bindAgent(): AgentLogCaptureBinding {
    // Distinct stable lifetime identity for each actual Agent, including selected/fallback agents.
    const identity = captureIdentity({ ...base, agentId: `agent-${randomUUID()}` });
    return Object.freeze({ identity, assertActive() { if (failure) throw failure; }, create(model: ModelInfo, transport: TransportKind, phase: 'startup' | 'turn', signal?: AbortSignal, session?: SessionIdentity) {
      if (failure) throw failure;
      const operationSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
      const capture = createRequiredLogCapture({ store, identity, actual: { provider: model.provider, model: model.id, transport, phase, attemptId: randomUUID(), ...(session ? { sessionId: session.id, transportEpoch: session.transportEpoch } : {}) }, maxPending, maxWriteMs, signal: operationSignal });
      capture.signal.addEventListener('abort', () => { fail(capture.signal.reason); }, { once: true });
      return Object.freeze({ ...capture, signal: AbortSignal.any([capture.signal, stopped.signal]),
        async run<T>(work: () => Promise<T>): Promise<T> { try { return await capture.run(work); } catch (error) { if (isExecutionHalted(error)) fail(error); throw error; } } });
    } });
  } });
}
