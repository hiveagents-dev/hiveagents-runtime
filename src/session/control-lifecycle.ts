import { AbortError, TimeoutError, UnsupportedCapabilityError } from '../public/errors.js';
import type { ProviderId, TurnOptions } from '../public/types.js';

/** Largest delay Node's timers honour without clamping to 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** One deadline and one abort listener for the lifetime of a control turn. */
export class ControlTurnLifecycle {
  readonly cancelled: Promise<Error>;
  readonly #controller = new AbortController();
  readonly signal: AbortSignal = this.#controller.signal;
  #cancel!: (error: Error) => void;
  #error: Error | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: () => void;
  #disposed = false;
  #terminalObserved = false;

  constructor(provider: ProviderId, options: TurnOptions) {
    if (options.signalBehavior === 'detach') {
      throw new UnsupportedCapabilityError(
        { provider, transport: 'control', retryable: false },
        'Detach is not supported for control turns',
      );
    }
    const timeoutMs = options.timeoutMs ?? 600_000;
    // Same contract as the exec path: Node clamps any timer outside
    // 1..2^31-1 to 1 ms, so a "safe integer" above that would time out at once.
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }
    this.cancelled = new Promise<Error>((resolve) => { this.#cancel = resolve; });
    this.#signal = options.signal;
    this.#onAbort = () => this.#trigger(this.#signal?.reason instanceof TimeoutError
      ? new TimeoutError({ provider, transport: 'control', retryable: true }, 'Control operation deadline exceeded')
      : new AbortError({ provider, transport: 'control', retryable: true }, 'Control turn aborted'));
    if (this.#signal?.aborted) {
      this.#onAbort();
      return;
    }
    this.#signal?.addEventListener('abort', this.#onAbort, { once: true });
    this.#timer = setTimeout(() => this.#trigger(new TimeoutError(
      { provider, transport: 'control', retryable: true },
      `Control turn timed out after ${timeoutMs} ms`,
    )), timeoutMs);
    this.#timer.unref();
  }

  get error(): Error | undefined { return this.#error; }
  get terminalObserved(): boolean { return this.#terminalObserved; }
  markTerminal(): void { this.#terminalObserved = true; }
  cancel(error: Error): void { this.#trigger(error); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#signal?.removeEventListener('abort', this.#onAbort);
  }

  #trigger(error: Error): void {
    if (this.#error || this.#disposed) return;
    this.#error = error;
    this.#controller.abort(error);
    this.#cancel(error);
    this.dispose();
  }
}

/** A missing terminal must not hold the public result forever. */
export const CONTROL_INTERRUPT_GRACE_MS = 1_000;

export async function settlesWithin(work: Promise<unknown>, timeoutMs = CONTROL_INTERRUPT_GRACE_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Settle one async cleanup operation without leaving a timeout behind. */
export async function withinGrace<T>(work: Promise<T>, timeoutMs = CONTROL_INTERRUPT_GRACE_MS): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then((value) => value, () => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
