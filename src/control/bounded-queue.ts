import { OutputLimitError } from '../public/errors.js';

export type OverflowPolicy = 'fail' | 'wait';

export interface BoundedQueueOptions<T> {
  maxItems?: number;
  maxBytes?: number;
  overflow?: OverflowPolicy;
  /** Bounds payloads retained by blocked enqueue calls. Default 1. */
  maxPendingProducers?: number;
  measure?: (value: T) => number;
}

function defaultMeasure<T>(value: T): number {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return Buffer.byteLength(serialized ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface QueuedValue<T> {
  value: T;
  bytes: number;
}

interface PendingProducer<T> {
  entry: QueuedValue<T>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class BoundedQueue<T> implements AsyncIterable<T> {
  readonly #values: Array<QueuedValue<T>> = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  readonly #producers: Array<PendingProducer<T>> = [];
  #closed = false;
  #failure: unknown;
  #queuedBytes = 0;
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #overflow: OverflowPolicy;
  readonly #maxPendingProducers: number;
  readonly #measure: (value: T) => number;

  constructor(options: BoundedQueueOptions<T> = {}) {
    this.#maxItems = options.maxItems ?? 1024;
    this.#maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.#overflow = options.overflow ?? 'fail';
    this.#maxPendingProducers = options.maxPendingProducers === undefined ? 1 : options.maxPendingProducers;
    if (!Number.isSafeInteger(this.#maxPendingProducers) || this.#maxPendingProducers < 1) {
      throw new RangeError('maxPendingProducers must be a positive safe integer');
    }
    this.#measure = options.measure ?? defaultMeasure;
  }

  get size(): number {
    return this.#values.length;
  }

  get bufferedBytes(): number {
    return this.#queuedBytes;
  }

  #hasCapacity(bytes: number): boolean {
    return this.#values.length < this.#maxItems && this.#queuedBytes + bytes <= this.#maxBytes;
  }

  #overflowError(): InstanceType<typeof OutputLimitError> {
    return new OutputLimitError(
      { retryable: false },
      `Async queue exceeded ${this.#maxItems} items or ${this.#maxBytes} bytes`,
    );
  }

  #accept(entry: QueuedValue<T>): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: entry.value });
      return;
    }
    this.#values.push(entry);
    this.#queuedBytes += entry.bytes;
  }

  push(value: T): void {
    if (this.#closed) return;
    const bytes = this.#measure(value);
    if (this.#waiters.length === 0 && !this.#hasCapacity(bytes)) throw this.#overflowError();
    this.#accept({ value, bytes });
  }

  async enqueue(value: T): Promise<void> {
    if (this.#closed) {
      if (this.#failure !== undefined) throw this.#failure;
      return;
    }
    const bytes = this.#measure(value);
    if (bytes > this.#maxBytes) throw this.#overflowError();
    if (this.#waiters.length > 0 || this.#hasCapacity(bytes)) {
      this.#accept({ value, bytes });
      return;
    }
    if (this.#overflow === 'fail') throw this.#overflowError();
    if (this.#producers.length >= this.#maxPendingProducers) {
      throw new OutputLimitError({ retryable: false,
        sanitizedDiagnostics: { maxPendingProducers: this.#maxPendingProducers } },
      `Async queue exceeded ${this.#maxPendingProducers} pending producers`);
    }
    return new Promise<void>((resolve, reject) => {
      this.#producers.push({ entry: { value, bytes }, resolve, reject });
    });
  }

  #admitProducers(): void {
    while (this.#producers.length > 0) {
      const head = this.#producers[0];
      if (head === undefined) return;
      if (this.#waiters.length === 0 && !this.#hasCapacity(head.entry.bytes)) return;
      this.#producers.shift();
      this.#accept(head.entry);
      head.resolve();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
    for (const producer of this.#producers.splice(0)) producer.resolve();
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#failure = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    for (const producer of this.#producers.splice(0)) producer.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const entry = this.#values.shift();
        if (entry !== undefined) {
          this.#queuedBytes = Math.max(0, this.#queuedBytes - entry.bytes);
          this.#admitProducers();
          return { done: false, value: entry.value };
        }
        if (this.#failure !== undefined) throw this.#failure;
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
          this.#admitProducers();
        });
      },
    };
  }
}
