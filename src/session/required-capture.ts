import { OperationScope } from '../control/operation-scope.js';
import { AbortError, AgentRuntimeError, TimeoutError } from '../public/errors.js';
import { isExecutionHalted } from '../public/execution-halt.js';
import type { AgentEvent, SessionIdentity, Turn, TurnOptions, Usage } from '../public/types.js';
import type { RequiredLogCapture } from '../orchestration/log/capture.js';
import type { SessionConfig } from './config.js';
import type { AgentLogCaptureBinding } from '../orchestration/log/capture-runtime.js';
import type { ModelInfo } from '../public/types.js';
import type { ControlSessionHandle } from './control-session.js';
import { withinGrace } from './control-lifecycle.js';
import { types } from 'node:util';
import { safeUsage } from '../orchestration/log/capture-codec.js';
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function observedUsage(value: unknown): unknown {
  const step = own(value, 'value'); return own(value, 'usage') ?? (own(step, 'kind') === 'result' ? own(own(step, 'result'), 'usage') : undefined);
}
/** Producer-owned required tap. Its bookkeeping is never native settlement/permission proof. */
export class RequiredTurnCapture {
  readonly #capture: RequiredLogCapture; readonly #scope: OperationScope;
  readonly #ready = deferred<void>(); readonly #done = deferred<unknown>(); readonly #result: Promise<unknown>;
  readonly #pending = new Set<Promise<unknown>>(); #failure: unknown; #usage: Usage | undefined; #finished = false;
  constructor(config: SessionConfig, options: TurnOptions, phase: 'startup' | 'turn' = 'turn', session?: SessionIdentity) {
    this.#scope = new OperationScope({ timeoutMs: options.timeoutMs ?? 600000, ...(options.signal ? { signal: options.signal } : {}), context: { provider: config.model.provider, transport: config.transport, retryable: true } });
    try { this.#capture = config.capture!.create(config.model, config.transport, phase, this.#scope.signal, session); }
    catch (error) { this.#scope.dispose(); throw error; }
    this.#result = this.#capture.run(async () => { this.#ready.resolve(); return this.#done.promise; });
    void this.#result.then(() => this.#scope.dispose(), error => { this.#ready.reject(error); this.#scope.dispose(); });
  }
  get signal(): AbortSignal { return AbortSignal.any([this.#scope.signal, this.#capture.signal]); }
  remainingMs(): number { return Math.max(1, this.#scope.remainingMs()); }
  async begin(): Promise<void> { await this.#ready.promise; this.throwIfFailed(); if (this.#scope.signal.aborted) throw this.#scope.signal.reason; }
  async observe(event: AgentEvent): Promise<void> { await this.#capture.observe(event); }
  throwIfFailed(): void { if (this.#capture.signal.aborted) throw this.#capture.signal.reason; }
  track(work: Promise<unknown>): void {
    this.#pending.add(work);
    void work.then(value => { this.#pending.delete(work); this.#retainUsage(observedUsage(value)); }, error => { this.#pending.delete(work); this.#retainUsage(own(own(error, 'context'), 'observedUsage')); if (isExecutionHalted(error)) this.#failure ??= error; });
  }
  #retainUsage(input: unknown): void { if (input !== undefined) try { safeUsage(input); this.#usage = structuredClone(input) as Usage; this.#capture.recordUsage(this.#usage); } catch { /* Malformed/absent usage is unknown; never invoke native getters. */ } }
  async complete<T>(value: T): Promise<T> { this.#finished = true; this.#done.resolve(value); await this.#result; return value; }
  async completeTurn(turn: Turn, bufferedEvents = false): Promise<Turn> {
    if (bufferedEvents) for (const event of turn.events) await this.observe(event);
    await this.observe({ type: 'turn.completed', turn }); return this.complete(turn);
  }
  async fail(error: unknown, awaitSettlement?: boolean): Promise<never> {
    this.#finished = true;
    const cancelled = error instanceof AbortError || error instanceof TimeoutError;
    if (cancelled || isExecutionHalted(error) || this.#scope.signal.aborted) this.#capture.markInterrupted();
    const finish = async () => {
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
      let original = this.#failure ?? error;
      if (this.#usage && cancelled && original instanceof AgentRuntimeError && !isExecutionHalted(original)) {
        const context = { ...original.context, observedUsage: this.#usage }, message = original.message;
        original = original instanceof TimeoutError ? new TimeoutError(context, message) : new AbortError(context, message);
      }
      this.#done.reject(original); return this.#result;
    };
    // A required-persistence failure must not wait on a noncooperative producer.
    if (this.#capture.signal.aborted) { this.#done.reject(this.#capture.signal.reason); try { await this.#result; } catch (halt) { throw halt; } }
    if (cancelled && !awaitSettlement) { void finish().catch(() => {}); throw error; }
    return finish() as Promise<never>;
  }
  abandon(): void {
    if (this.#finished) return; this.#capture.markInterrupted(); this.#scope.cancel();
    void this.fail(new AbortError({ retryable: false }, 'Captured consumer stopped reading'), false).catch(() => {});
  }
}
export function requiredTurnCapture(config: SessionConfig, options: TurnOptions, session?: SessionIdentity): RequiredTurnCapture | undefined {
  config.capture?.assertActive(); return config.capture && !options.signal?.aborted ? new RequiredTurnCapture(config, options, 'turn', session) : undefined;
}
/** Required startup ACK precedes a control factory which may launch a CLI. No turn/debit is invented. */
export async function captureControlOpen(binding: AgentLogCaptureBinding | undefined, model: ModelInfo, signal: AbortSignal | undefined, open: () => Promise<ControlSessionHandle>): Promise<ControlSessionHandle> {
  if (!binding) return open();
  const capture = binding.create(model, 'control', 'startup', signal); let opened: ControlSessionHandle | undefined, closing: Promise<unknown> | undefined;
  const closeOnce = () => { closing ??= Promise.resolve().then(() => opened!.close()); return withinGrace(closing); };
  const onAbort = () => capture.markInterrupted(); signal?.addEventListener('abort', onAbort, { once: true });
  const work = capture.run(async () => {
    opened = await open();
    if (capture.signal.aborted || signal?.aborted) { capture.markInterrupted(); await closeOnce(); throw capture.signal.aborted ? capture.signal.reason : signal!.reason; }
    return opened;
  });
  try {
    return await new Promise<ControlSessionHandle>((resolve, reject) => {
      let finished = false;
      const complete = (callback: () => void) => { if (finished) return; finished = true; capture.signal.removeEventListener('abort', fail); callback(); };
      const fail = () => complete(() => reject(capture.signal.reason));
      work.then(value => complete(() => resolve(value)), error => complete(() => reject(error)));
      if (capture.signal.aborted) fail(); else capture.signal.addEventListener('abort', fail, { once: true });
    });
  } catch (error) { if (opened) await closeOnce(); throw error; }
  finally { signal?.removeEventListener('abort', onAbort); }
}
