import { BoundedQueue } from '../control/bounded-queue.js';
import type { AgentEvent } from '../public/types.js';

/** A slow/absent observer can fail its own stream without cancelling provider work. */
export class TurnEvents implements AsyncIterable<AgentEvent> {
  readonly #queue = new BoundedQueue<AgentEvent>({ maxItems: 4096, maxBytes: 64 * 1024 * 1024 });
  #failed = false;
  push(event: AgentEvent): void {
    if (this.#failed) return;
    try { this.#queue.push(event); }
    catch (error) { this.fail(error); }
  }
  close(): void { this.#queue.close(); }
  fail(error: unknown): void { this.#failed = true; this.#queue.fail(error); }
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> { return this.#queue[Symbol.asyncIterator](); }
}
