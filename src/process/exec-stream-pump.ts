import type { AdapterStreamItem, ProtocolResult } from '../adapters/provider.js';
import { BoundedQueue } from '../control/bounded-queue.js';
import { AbortError, AgentRuntimeError, ProtocolError, TimeoutError } from '../public/errors.js';
import type { Usage } from '../public/types.js';
import { IncrementalLineDecoder, ProtocolResultAccumulator } from './json-lines.js';

type Progress = Exclude<AdapterStreamItem, { kind: 'result' }>;

/** One cooperative producer, bounded progress, and a separately retained terminal result. */
export class ExecStreamPump {
  readonly #queue = new BoundedQueue<Progress>({ overflow: 'wait', maxPendingProducers: 1 });
  readonly #decoder = new IncrementalLineDecoder();
  readonly #accumulator = new ProtocolResultAccumulator();
  readonly #stop = new AbortController();
  readonly signal: AbortSignal;
  readonly #parseLine: (line: string) => ProtocolResult;
  readonly #parseFinal: (raw: string) => ProtocolResult;
  #announcedSession: string | undefined;
  #mode: 'sync' | 'async' | undefined;
  #delivering = false;
  #failed = false;
  #failure: unknown;
  #finished = false;
  #terminal: ProtocolResult | undefined;
  #usage: Usage | undefined;

  constructor(signal: AbortSignal | undefined, parseLine: (line: string) => ProtocolResult,
    parseFinal: (raw: string) => ProtocolResult) {
    this.signal = signal ? AbortSignal.any([signal, this.#stop.signal]) : this.#stop.signal;
    this.#parseLine = parseLine; this.#parseFinal = parseFinal;
    this.signal.addEventListener('abort', this.#onAbort, { once: true });
    if (this.signal.aborted) this.#onAbort();
  }

  readonly #onAbort = () => this.fail(new AbortError({ retryable: true }));

  #check(mode?: 'sync' | 'async'): void {
    if (this.#failed) throw this.#failure;
    if (this.#finished || (mode && this.#mode && mode !== this.#mode)) {
      throw new ProtocolError({ retryable: false }, 'Invalid exec output delivery sequence');
    }
    if (mode) this.#mode = mode;
  }

  *#items(line: string): Iterable<Progress> {
    const parsed = this.#parseLine(line);
    this.#rememberUsage(parsed.usage);
    this.#accumulator.observe(line, parsed);
    if (parsed.sessionId && parsed.sessionId !== this.#announcedSession) {
      this.#announcedSession = parsed.sessionId;
      yield { kind: 'session', sessionId: parsed.sessionId };
    }
    for (const event of parsed.events) yield { kind: 'event', event };
  }

  /** Legacy runners keep synchronous bounded overflow rather than spawning waiting promises. */
  readonly onStdout = (chunk: Uint8Array): void => {
    try {
      this.#check('sync');
      for (const line of this.#decoder.push(chunk)) for (const item of this.#items(line)) this.#queue.push(item);
    } catch (error) { this.fail(error); throw error; }
  };

  readonly onStdoutAsync = (chunk: Uint8Array, signal: AbortSignal = this.signal): Promise<void> => {
    const work = this.#deliver(chunk, signal);
    // A custom runner may ignore returned promises. Keep the error observable
    // to cooperative callers without producing unhandled rejections otherwise.
    void work.catch(() => undefined);
    return work;
  };

  async #deliver(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    let ownsDelivery = false;
    const abort = () => this.fail(signal.reason instanceof Error ? signal.reason : new AbortError({ retryable: true }));
    try {
      this.#check('async');
      if (this.#delivering) throw new ProtocolError({ retryable: false }, 'Exec runner ignored output acknowledgment');
      this.#delivering = true; ownsDelivery = true;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.#check();
      for (const line of this.#decoder.push(chunk)) {
        for (const item of this.#items(line)) await this.#queue.enqueue(item);
      }
    } catch (error) { this.fail(error); throw error; }
    finally { if (ownsDelivery) { signal.removeEventListener('abort', abort); this.#delivering = false; } }
  }

  async finish(project: (result: ProtocolResult) => ProtocolResult): Promise<void> {
    this.#check();
    if (this.#delivering) throw new ProtocolError({ retryable: false }, 'Exec runner completed before output acknowledgment');
    for (const line of this.#decoder.finish()) {
      for (const item of this.#items(line)) await this.#queue.enqueue(item);
    }
    this.#check();
    this.#terminal = project(this.#accumulator.finish(this.#parseFinal));
    this.#rememberUsage(this.#terminal.usage);
    this.#finished = true; this.#queue.close();
  }

  fail(error: unknown): void {
    if (error instanceof AgentRuntimeError) this.#rememberUsage(error.context.observedUsage);
    if (this.#failed) return;
    this.#failed = true;
    this.#failure = error === undefined ? new ProtocolError({ retryable: false }, 'Exec runner failed without a cause') : error;
    this.#queue.fail(this.#failure);
  }

  #rememberUsage(usage: Usage | undefined): void {
    if (usage !== undefined) {
      try { this.#usage = structuredClone(usage); } catch { /* Unknown accounting stays unknown. */ }
    }
  }

  /** Called only after opted-in actual execution settles; no text or identity is adopted. */
  afterSettlement(primary: unknown): unknown {
    if (!(primary instanceof AbortError || primary instanceof TimeoutError) || this.#usage === undefined) return primary;
    const context = { ...primary.context, observedUsage: structuredClone(this.#usage) };
    const message = primary.message;
    const enriched = primary instanceof TimeoutError ? new TimeoutError(context, message) : new AbortError(context, message);
    if (primary.stack !== undefined) enriched.stack = primary.stack;
    if (Object.hasOwn(primary, 'cause')) Object.defineProperty(enriched, 'cause', Object.getOwnPropertyDescriptor(primary, 'cause')!);
    return enriched;
  }

  async *items(): AsyncIterable<AdapterStreamItem> {
    yield* this.#queue;
    if (this.#failed) throw this.#failure;
    if (this.#terminal) yield { kind: 'result', result: this.#terminal };
  }

  cancel(): void {
    // Wake blocked producers before any caller waits for underlying execution.
    this.#stop.abort();
    this.signal.removeEventListener('abort', this.#onAbort);
  }
}
