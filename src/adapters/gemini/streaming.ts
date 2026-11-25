import { OutputLimitError } from "../../public/errors.js";
/** Bounded handoff; transcript storage is independently bounded by runProcess. */
export class StreamQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  #error: unknown;
  push(value: T): void {
    if (this.#ended) return;
    if (this.#values.length >= 1024)
      throw new OutputLimitError(
        { provider: "gemini", retryable: false },
        "Gemini consumer fell behind the bounded stream",
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
