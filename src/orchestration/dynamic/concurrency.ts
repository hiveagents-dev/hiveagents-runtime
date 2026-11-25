/**
 * Dynamic workflows: the run's adaptive concurrency window and the rate-limit backoff.
 *
 * `DynamicLimits.concurrency` is a ceiling. The run admits calls through a window that starts at
 * `initialConcurrency` (default min(4, ceiling)) and adapts to the provider's own typed signal:
 * - a call whose attempt the provider rate-limited (`DynamicRunnerError` RATE_LIMITED) cuts the window to
 *   floor(0.75 x window), at least 1 (8 -> 6 -> 4 -> 3 -> 2 -> 1). Only an attempt that started under the
 *   current window does so: the rejections of calls launched before the last cut are the same congestion,
 *   already answered (TCP's one reduction per round trip), so a burst of rejections cuts once;
 * - an answered attempt (the runner returned) while the window is full grows it by 1, up to the ceiling.
 *   Answers while the window is not full prove nothing about a larger one and do not count.
 * Calls in flight above a cut window are never interrupted: new grants wait until they settle.
 *
 * The constants were chosen in the W3 twin (scripts/simulation/workflows/throughput.mjs) against fixed
 * concurrency 1..16 under a token-bucket limit: halving with +1 per window of answers stayed at or below
 * fixed 4 (it rarely left the start on 8-60 call workloads), while a 0.75 cut (CUBIC uses 0.7) with +1
 * per answered call while full was the best of the variants tried at 3, 6 and 15 requests/min.
 *
 * A rate-limited call is retried after a backoff, exponential with jitter, and never holds a slot while it
 * waits. The jitter is derived from the call key and the retry number, not from a random source, so a
 * run is reproducible while different calls still spread out.
 */
import { checksum } from '../../shared/json.js';

/** The time source of rate-limit backoff waits; default real time (`Date.now`, `setTimeout`). */
export interface DynamicClock {
  /** Epoch milliseconds, the same clock as a provider `retryAt`. */
  now(): number;
  /** Resolves after `ms`; rejects promptly once `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: DynamicClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
  }),
});

/** Backoff of rate-limit retries: retry n waits in [d/2, d) with d = min(maxMs, baseMs * 2^n). */
export const DYNAMIC_RATE_LIMIT_BACKOFF = Object.freeze({ baseMs: 5_000, maxMs: 60_000 });

/** A deterministic uniform in [0, 1) from a call key and a retry number. */
function jitter(key: string, retry: number): number {
  return Number.parseInt(checksum(`rate-limit:${key}:${retry}`).slice(0, 12), 16) / 2 ** 48;
}

/**
 * How long a rate-limited call waits before retry `retry` (0-based), or `undefined` when the provider's
 * reset (`retryAt`, epoch ms) is further away than `maxWaitMs`: retrying before it cannot succeed, and
 * waiting longer than the call's own timeout is not a wait the application bounded.
 */
export function rateLimitDelay(key: string, retry: number, retryAt: number | undefined, now: number, maxWaitMs: number): number | undefined {
  const { baseMs, maxMs } = DYNAMIC_RATE_LIMIT_BACKOFF;
  const ceiling = Math.min(maxMs, baseMs * 2 ** retry);
  const spread = jitter(key, retry);
  let delay = ceiling / 2 + (spread * ceiling) / 2;
  if (retryAt !== undefined) {
    const until = retryAt - now;
    if (until > maxWaitMs) return undefined;
    // Calls released by the same reset do not all retry at the same instant.
    delay = Math.max(delay, until + (spread * baseMs) / 2);
  }
  return Math.round(delay);
}

export interface DynamicWindowChange {
  readonly previous: number;
  readonly window: number;
  readonly reason: 'rate-limited' | 'recovered';
}

/** The multiplicative cut of the window on a rate limit (floored, at least 1). */
export const DYNAMIC_WINDOW_CUT = 0.75;

/** A FIFO counting semaphore whose size adapts between 1 and its ceiling. */
export class DynamicWindow {
  #size: number;
  #active = 0;
  #epoch = 0;
  readonly #queue: Array<() => void> = [];

  constructor(readonly ceiling: number, initial: number, private readonly onChange: (change: DynamicWindowChange) => void = () => {}) {
    this.#size = Math.max(1, Math.min(ceiling, initial));
  }

  /** The current window. */
  get size(): number { return this.#size; }
  /** Increments at each cut; an attempt records it when it starts. */
  get epoch(): number { return this.#epoch; }

  /** Resolves true once a slot is granted; false (without a slot) once `signal` aborts first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#active < this.#size && this.#queue.length === 0) { this.#active++; return Promise.resolve(true); }
    return new Promise(resolve => {
      const grant = () => { signal.removeEventListener('abort', abandon); resolve(true); };
      const abandon = () => {
        const index = this.#queue.indexOf(grant);
        if (index >= 0) this.#queue.splice(index, 1);
        resolve(false);
      };
      this.#queue.push(grant);
      signal.addEventListener('abort', abandon, { once: true });
    });
  }

  release(): void {
    this.#active--;
    this.#pump();
  }

  /** An attempt that started in `epoch` was rate-limited: cut once per epoch. */
  rateLimited(epoch: number): void {
    if (epoch !== this.#epoch) return;
    this.#epoch++;
    const previous = this.#size;
    this.#size = Math.max(1, Math.floor(previous * DYNAMIC_WINDOW_CUT));
    if (this.#size !== previous) this.onChange({ previous, window: this.#size, reason: 'rate-limited' });
  }

  /** An attempt that started in `epoch` was answered; call it while that attempt still holds its slot. */
  succeeded(epoch: number): void {
    if (epoch !== this.#epoch || this.#size >= this.ceiling || this.#active < this.#size) return;
    const previous = this.#size;
    this.#size++;
    this.onChange({ previous, window: this.#size, reason: 'recovered' });
    this.#pump();
  }

  #pump(): void {
    while (this.#active < this.#size && this.#queue.length > 0) {
      this.#active++;
      this.#queue.shift()!();
    }
  }
}
