import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { IncrementalLineDecoder } from '../../process/json-lines.js';
import { ProtocolError } from '../../public/errors.js';
import type { RpcMessage } from './rpc-peer.js';

export interface CodexJsonlChannelOptions {
  input: Readable;
  output: Writable;
  maxFrameBytes: number;
  /**
   * Receives a stdout line that is not a JSON object. When present the line
   * is reported and skipped instead of killing the pump: a stray log line is
   * not a reason to lose the transport. Absent, malformed lines are protocol
   * errors as before.
   */
  onMalformedLine?: (line: string) => void;
}

export class CodexJsonlChannel {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #decoder: IncrementalLineDecoder;
  readonly #onMalformedLine: CodexJsonlChannelOptions['onMalformedLine'];

  constructor(options: CodexJsonlChannelOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#decoder = new IncrementalLineDecoder({ maxBufferedBytes: options.maxFrameBytes });
    this.#onMalformedLine = options.onMalformedLine;
  }

  async write(message: RpcMessage): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    if (this.#output.write(frame)) return;
    await once(this.#output, 'drain');
  }

  async pump(onMessage: (message: RpcMessage) => Promise<void>): Promise<void> {
    for await (const chunk of this.#input) {
      for (const line of this.#decoder.push(chunk as Uint8Array)) {
        await this.#deliver(line, onMessage);
      }
    }
    for (const line of this.#decoder.finish()) {
      await this.#deliver(line, onMessage);
    }
  }

  async #deliver(line: string, onMessage: (message: RpcMessage) => Promise<void>): Promise<void> {
    if (!line.trim()) return;
    const message = this.#parse(line);
    if (message === undefined) {
      if (!this.#onMalformedLine) {
        throw new ProtocolError(
          { provider: 'codex', transport: 'control', retryable: false },
          'Codex App Server emitted a malformed JSONL frame',
        );
      }
      this.#onMalformedLine(line);
      return;
    }
    await onMessage(message);
  }

  #parse(line: string): RpcMessage | undefined {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as RpcMessage;
      }
    } catch {
      // Not JSON: reported as noise or raised as a protocol error by the caller.
    }
    return undefined;
  }
}
