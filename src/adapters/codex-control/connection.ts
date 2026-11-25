import type { Readable, Writable } from 'node:stream';

import { ProtocolError, ProviderUnavailableError } from '../../public/errors.js';
import { CodexJsonlChannel } from './jsonl-channel.js';
import { CodexRpcPeer, type RpcId } from './rpc-peer.js';

export interface CodexAppServerConnectionOptions {
  input: Readable;
  output: Writable;
  epoch: string;
  experimentalApi?: boolean;
  maxFrameBytes?: number;
  onServerRequest?(method: string, params: unknown, id: RpcId): Promise<unknown>;
  onNotification?(method: string, params: unknown): void | Promise<void>;
  /**
   * The transport died underneath us (stream ended, structural RPC error, a
   * late answer that could not be written) while nobody called close(). Fired
   * at most once; never after close().
   */
  onDeath?(error: unknown): void;
  /** A non-JSON stdout line, tolerated instead of killing the pump. */
  onNoise?(line: string): void;
}

export class CodexAppServerConnection {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #channel: CodexJsonlChannel;
  readonly #peer: CodexRpcPeer;
  readonly #pump: Promise<void>;
  readonly #experimentalApi: boolean;
  readonly #onDeath: CodexAppServerConnectionOptions['onDeath'];
  #initialized = false;
  #closed = false;
  #died = false;

  constructor(options: CodexAppServerConnectionOptions) {
    this.#input = options.input;
    this.#output = options.output;
    // Single source of truth: the constructor flag drives both the peer's
    // schema variant and the initialize() capability advertisement.
    this.#experimentalApi = options.experimentalApi === true;
    this.#onDeath = options.onDeath;
    const onNoise = options.onNoise ?? (() => undefined);
    this.#channel = new CodexJsonlChannel({
      input: options.input,
      output: options.output,
      maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024,
      onMalformedLine: onNoise,
    });
    this.#peer = new CodexRpcPeer({
      epoch: options.epoch,
      write: (message) => this.#channel.write(message),
      experimentalApi: this.#experimentalApi,
      // A late server answer that cannot reach the wire is transport death.
      onAsyncError: (error) => this.#die(error),
      ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    });
    this.#pump = this.#channel.pump((message) => this.#peer.receive(message));
    // A pump that ends for any reason while we did not close it is transport
    // death: pending requests fail with the cause and the owner is told, so
    // the thread state, the broker and the child process follow suit instead
    // of looking active until the turn deadline.
    void this.#pump.then(
      () => this.#die(new ProviderUnavailableError(
        { provider: 'codex', transport: 'control', retryable: true },
        'Codex App Server stream ended',
      )),
      (error) => this.#die(error),
    );
  }

  #die(error: unknown): void {
    this.#peer.close(error);
    if (this.#closed || this.#died) return;
    this.#died = true;
    this.#onDeath?.(error);
  }

  async initialize(): Promise<unknown> {
    if (this.#initialized) {
      throw new ProtocolError(
        { provider: 'codex', transport: 'control', retryable: false },
        'Codex App Server connection was already initialized',
      );
    }
    const capabilities = this.#experimentalApi ? { experimentalApi: true } : undefined;
    const result = await this.#peer.request('initialize', {
      clientInfo: {
        name: 'open_agent_runtime',
        title: 'HiveAgents Runtime',
        version: '0.1.0-beta.3',
      },
      ...(capabilities === undefined ? {} : { capabilities }),
    });
    await this.#channel.write({ method: 'initialized', params: {} });
    this.#initialized = true;
    return result;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.#initialized && method !== 'initialize') {
      return Promise.reject(new ProtocolError(
        { provider: 'codex', transport: 'control', retryable: false },
        'Codex App Server request attempted before initialization',
      ));
    }
    return this.#peer.request(method, params);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#peer.close();
    this.#input.destroy();
    this.#output.end();
    await this.#pump.catch(() => undefined);
  }
}
