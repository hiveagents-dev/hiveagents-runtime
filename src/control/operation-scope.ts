import { AbortError, TimeoutError, type ErrorContext } from '../public/errors.js';
import { rethrowExecutionHalt } from '../public/execution-halt.js';

export interface OperationScopeOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  context?: ErrorContext;
}

/** One monotonic budget and derived cancellation signal for a compound operation. */
export class OperationScope {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal = this.#controller.signal;
  readonly deadline: number;
  readonly #expires: number;
  readonly #parent: AbortSignal | undefined;
  readonly #onAbort: () => void;
  readonly #context: ErrorContext;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #error: Error | undefined;
  #halt: { error: unknown } | undefined;
  #disposed = false;
  readonly #work = new Set<Promise<unknown>>();
  readonly #pending = new Set<(error: Error) => void>();

  constructor(options: OperationScopeOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2 ** 31 - 1) {
      throw new RangeError('timeoutMs must be an integer between 1 and 2147483647');
    }
    this.deadline = Date.now() + options.timeoutMs;
    this.#expires = performance.now() + options.timeoutMs;
    this.#context = { retryable: true, ...options.context };
    this.#parent = options.signal;
    this.#onAbort = () => this.#abort(this.#parent?.reason instanceof TimeoutError
      ? new TimeoutError(this.#context, 'Operation deadline exceeded')
      : new AbortError(this.#context, 'Operation aborted'));
    if (this.#parent?.aborted) this.#onAbort();
    else {
      this.#parent?.addEventListener('abort', this.#onAbort, { once: true });
      this.#timer = setTimeout(() => this.#abort(new TimeoutError(this.#context, 'Operation deadline exceeded')), options.timeoutMs);
    }
  }

  remainingMs(): number { return Math.max(0, Math.floor(this.#expires - performance.now())); }

  async race<T>(work: () => Promise<T> | T): Promise<T> {
    this.#assertActive();
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error) => reject(error);
      this.#pending.add(cancel);
      // Promise assimilation observes late rejection even when cancellation won.
      let pending: Promise<T>;
      try { pending = Promise.resolve(work()); }
      catch (error) { this.#pending.delete(cancel); reject(this.#observeFailure(error)); return; }
      this.#work.add(pending);
      void pending.then(() => this.#work.delete(pending), () => this.#work.delete(pending));
      pending.then(
        (value) => {
          this.#pending.delete(cancel);
          try { this.#assertActive(); resolve(value); } catch (error) { reject(error); }
        },
        (error: unknown) => { this.#pending.delete(cancel); reject(this.#observeFailure(error)); },
      );
    });
  }

  /** Wait for actual work, including work whose public race already timed out. */
  async drain(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  /** Settled ownership boundaries can retain a genuine late halt after a public cancellation won. */
  rethrowExecutionHalt(): void { if (this.#halt) throw this.#halt.error; }

  #observeFailure(error: unknown): unknown {
    try { rethrowExecutionHalt(error); }
    catch (halt) { this.#halt ??= { error: halt }; }
    return this.#halt?.error ?? this.#error ?? error;
  }

  cancel(): void { this.#abort(new AbortError(this.#context, 'Operation ended')); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#parent?.removeEventListener('abort', this.#onAbort);
  }

  #assertActive(): void {
    if (!this.#error && this.remainingMs() < 1) this.#abort(new TimeoutError(this.#context, 'Operation deadline exceeded'));
    if (this.#error) throw this.#error;
    if (this.#disposed) throw new AbortError(this.#context, 'Operation scope is disposed');
  }

  #abort(error: Error): void {
    if (this.#error || this.#disposed) return;
    this.#error = error;
    this.#controller.abort(error);
    for (const cancel of this.#pending) cancel(error);
    this.#pending.clear();
    this.dispose();
  }
}
