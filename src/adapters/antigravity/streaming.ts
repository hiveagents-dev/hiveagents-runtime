import { OutputLimitError } from "../../public/errors.js";
/** Bound consumer lag independently from the process transcript's byte bound. */
export class StreamQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  #error: unknown;
  push(value: T): void {
    if (this.#ended) return;
    if (this.#values.length >= 1024)
      throw new OutputLimitError(
        { provider: "antigravity", retryable: false },
        "Antigravity consumer exceeded the bounded stream queue",
      );
    this.#values.push(value);
    this.#wake?.();
  }
  close(error?: unknown): void {
    this.#ended = true;
    this.#error = error;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#values.length) {
        yield this.#values.shift()!;
        continue;
      }
      if (this.#ended) {
        if (this.#error) throw this.#error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}
