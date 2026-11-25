import type { ProtocolResult } from '../adapters/provider.js';
import { OutputLimitError } from '../public/errors.js';
import type { AgentEvent } from '../public/types.js';
import { assertJsonlFrame, DEFAULT_MAX_FRAME_BYTES } from './jsonl-frames.js';
import { confirmedUsageRetryAt } from '../adapters/provider-limits.js';

export class IncrementalLineDecoder {
  readonly #decoder = new TextDecoder();
  readonly #maxBufferedBytes: number;
  #buffer = '';
  #failure: InstanceType<typeof OutputLimitError> | undefined;

  constructor(options: { maxBufferedBytes?: number } = {}) {
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  #checkFrame(frame: string): void {
    try { assertJsonlFrame(frame, this.#maxBufferedBytes); }
    catch (error) {
      this.#buffer = ''; this.#failure = error as InstanceType<typeof OutputLimitError>;
      throw error;
    }
  }

  /**
   * A frame over the limit is terminal: the partial frame is discarded, the
   * same error is rethrown for every later chunk, and the frame is never
   * delivered when its newline finally arrives. Throwing once per chunk while
   * keeping the buffer used to surface as one uncaught exception per chunk in
   * the host and then hand the oversized frame to the consumer anyway.
   */
  push(chunk: Uint8Array): string[] {
    if (this.#failure) throw this.#failure;
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) this.#checkFrame(line);
    // A trailing CR may be half of a CRLF delimiter. If EOF follows instead,
    // finish() checks it as content, without extending the frame allowance.
    this.#checkFrame(this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer);
    return lines;
  }

  assertHealthy(): void {
    if (this.#failure) throw this.#failure;
  }

  finish(): string[] {
    if (this.#failure) return [];
    this.#buffer += this.#decoder.decode();
    this.#checkFrame(this.#buffer);
    if (this.#buffer.length === 0) return [];
    const line = this.#buffer;
    this.#buffer = '';
    return [line];
  }
}

/** Preserve an observed frame failure even when a custom runner swallows its callback error. */
export async function guardJsonlFrames<T>(work: (onStdout: (chunk: Uint8Array) => void) => Promise<T>): Promise<T> {
  const frames = new IncrementalLineDecoder();
  try {
    const result = await work(chunk => { frames.push(chunk); });
    frames.finish();
    return result;
  } finally { frames.assertHealthy(); }
}

/**
 * Builds the terminal ProtocolResult of a streamed exec turn from the lines
 * already parsed one by one, instead of re-parsing the whole stdout (up to
 * 64 MB, synchronous, in the host's main thread) once the process exits.
 *
 * Identity, text, events and native events accumulate incrementally. The
 * verdict (completed/failed/failure/usage/terminalEvent/output) depends on the
 * terminal line and on every error line seen, so exactly those lines are kept
 * raw and parsed again together: a few lines, never the transcript.
 */
export class ProtocolResultAccumulator {
  readonly #events: AgentEvent[] = [];
  readonly #nativeEvents: unknown[] = [];
  readonly #verdictLines: string[] = [];
  #sessionId: string | undefined;
  #turnId: string | undefined;
  #text = '';

  observe(line: string, parsed: ProtocolResult): void {
    if (parsed.sessionId !== undefined) this.#sessionId = parsed.sessionId;
    if (parsed.turnId !== undefined) this.#turnId = parsed.turnId;
    for (const event of parsed.events) {
      if (event.type === 'message.completed') this.#text = event.text;
    }
    this.#events.push(...parsed.events);
    this.#nativeEvents.push(...parsed.nativeEvents);
    // A lone non-terminal line parses to the 'protocol' failure "stream ended
    // without a result"; any other failure kind means the line carried an error.
    if (parsed.terminalEvent !== undefined || (parsed.failure !== undefined && parsed.failure.kind !== 'protocol')) {
      this.#verdictLines.push(line);
    }
  }

  finish(parse: (raw: string) => ProtocolResult): ProtocolResult {
    const verdict = parse(this.#verdictLines.join('\n'));
    const retryAt = confirmedUsageRetryAt(this.#events);
    const terminal = verdict.terminalEvent as Record<string, unknown> | undefined;
    const failure = verdict.failure && terminal?.type === 'result' && terminal.api_error_status === 429 && retryAt !== undefined
      ? { kind: 'usage-limit' as const, message: 'Provider usage limit reached' } : verdict.failure;
    return {
      ...verdict,
      ...(failure?.kind === 'usage-limit' && retryAt !== undefined ? { failure: { ...failure, retryAt } } : {}),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
      text: this.#text,
      events: this.#events,
      nativeEvents: this.#nativeEvents,
    };
  }
}
