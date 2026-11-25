import { TwoLaneDelivery } from '../../control/bounded-lanes.js';
import { createControlBuffer, type ControlBuffer, type ControlBufferLimits } from '../../control/event-spool.js';
import { ProviderUnavailableError, SessionBusyError, type AgentRuntimeError } from '../../public/errors.js';
import type { AgentEvent } from '../../public/types.js';
import type { CodexCriticalEvent } from './projector.js';

export type SequencedItem =
  | { lane: 'public'; event: AgentEvent }
  | { lane: 'critical'; item: CodexCriticalEvent };

/** Turn-local delivery: RPC publication never waits on disk or on a public consumer. */
export class SequencedDelivery extends TwoLaneDelivery<CodexCriticalEvent, AgentEvent> {
  #buffer: ControlBuffer<SequencedItem> | undefined;
  #preparing: Promise<ControlBuffer<SequencedItem>> | undefined;
  #closed = false;
  #failure: AgentRuntimeError | undefined;
  #onTerminal: (() => void) | undefined;
  get busy(): boolean { return this.#buffer !== undefined || this.#preparing !== undefined; }
  get failed(): boolean { return this.#failure !== undefined; }
  get failure(): AgentRuntimeError | undefined { return this.#failure; }

  async begin(epoch: string, limits: ControlBufferLimits, onFailure: (error: AgentRuntimeError) => void, onTerminal: () => void): Promise<ControlBuffer<SequencedItem>> {
    if (this.#failure) throw this.#failure;
    if (this.busy) throw new SessionBusyError({ provider: 'codex', transport: 'control', retryable: true });
    if (this.#closed) throw this.#closedError();
    let buffer: ControlBuffer<SequencedItem> | undefined;
    const preparing = createControlBuffer<SequencedItem>({ ...limits, epoch,
      context: { provider: 'codex', transport: 'control', retryable: false }, isCritical: item => item.lane === 'critical',
      onFailure: error => { if (buffer && this.#buffer === buffer) { this.#failure ??= error; onFailure(error); } },
    });
    this.#preparing = preparing;
    try {
      buffer = await preparing;
      if (this.#closed) { await buffer.dispose(); throw this.#closedError(); }
      this.#buffer = buffer; this.#onTerminal = onTerminal; return buffer;
    } finally { if (this.#preparing === preparing) this.#preparing = undefined; }
  }
  override publishEvent(event: AgentEvent): void { this.#buffer?.push({ lane: 'public', event }); }
  override pushCritical(item: CodexCriticalEvent): void {
    this.#buffer?.push({ lane: 'critical', item });
    if (item.kind === 'turn-terminal') { this.#onTerminal?.(); this.#buffer?.close(); }
  }
  override close(): void { this.#closed = true; this.#buffer?.close(); super.close(); }
  override fail(error: unknown): void { this.#buffer?.fail(error); super.close(); }
  async end(buffer: ControlBuffer<SequencedItem>): Promise<void> {
    try { await buffer.dispose(); }
    finally { if (this.#buffer === buffer) { this.#buffer = undefined; this.#onTerminal = undefined; } }
  }
  #closedError(): AgentRuntimeError { return new ProviderUnavailableError({ provider: 'codex', transport: 'control', retryable: false }, 'Codex delivery closed before turn dispatch'); }
  async dispose(): Promise<void> {
    const pending = this.#preparing;
    if (pending) { const buffer = await pending.catch(() => undefined); await buffer?.dispose(); }
    if (this.#buffer) await this.end(this.#buffer);
  }
}

/** A generator's finally is skipped when return/throw precedes its first next. */
export function finalizedIterator<T>(stream: AsyncIterable<T>, finalize: () => Promise<void>): AsyncIterableIterator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    async next() { const step = await iterator.next(); if (step.done) await finalize(); return step; },
    async return(value?: unknown) {
      await finalize();
      return iterator.return ? iterator.return(value) : { done: true, value };
    },
    async throw(error?: unknown) {
      await finalize();
      if (iterator.throw) return iterator.throw(error);
      throw error;
    },
    [Symbol.asyncIterator]() { return this; },
  };
}
