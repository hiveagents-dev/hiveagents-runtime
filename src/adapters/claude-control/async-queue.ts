interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

/** Cola async abierta: alimenta el prompt streaming y el output pump. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Waiter<T>[] = [];
  #ended = false;
  #error: unknown;

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#ended) {
      return this.#error === undefined
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.reject(this.#error);
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
