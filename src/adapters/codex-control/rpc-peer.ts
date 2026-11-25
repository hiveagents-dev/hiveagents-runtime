import { ProtocolError, ProviderUnavailableError } from '../../public/errors.js';
import { rethrowExecutionHalt } from '../../public/execution-halt.js';
import {
  isServerRequestMethod,
  validateEnvelope,
  validateServerRequestFrame,
  type CodexSchemaVariant,
} from './schemas.js';

export type RpcId = string | number;
export type RpcMessage = Record<string, unknown> & { id?: RpcId; method?: string };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface CodexRpcPeerOptions {
  epoch: string;
  experimentalApi?: boolean;
  maxPending?: number;
  write(message: RpcMessage): Promise<void>;
  onServerRequest?(method: string, params: unknown, id: RpcId): Promise<unknown>;
  onNotification?(method: string, params: unknown): void | Promise<void>;
  /**
   * Server requests are answered off the receive path (a pending approval must
   * not block deltas or interrupts), so a failure to write that late answer
   * cannot reject `receive`; it is reported here instead.
   */
  onAsyncError?(error: unknown): void;
}

function idKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

export class CodexRpcPeer {
  readonly #epoch: string;
  readonly #schemaVariant: CodexSchemaVariant;
  readonly #write: CodexRpcPeerOptions['write'];
  readonly #onServerRequest: CodexRpcPeerOptions['onServerRequest'];
  readonly #onNotification: CodexRpcPeerOptions['onNotification'];
  readonly #onAsyncError: CodexRpcPeerOptions['onAsyncError'];
  readonly #maxPending: number;
  readonly #outbound = new Map<string, PendingRequest>();
  readonly #inbound = new Set<string>();
  readonly #inFlight = new Set<Promise<void>>();
  #counter = 0;
  #closed = false;
  #closeReason: unknown;

  constructor(options: CodexRpcPeerOptions) {
    this.#epoch = options.epoch;
    this.#schemaVariant = options.experimentalApi === true ? 'experimental' : 'stable';
    this.#write = options.write;
    this.#onServerRequest = options.onServerRequest;
    this.#onNotification = options.onNotification;
    this.#onAsyncError = options.onAsyncError;
    this.#maxPending = options.maxPending ?? 256;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      try { rethrowExecutionHalt(this.#closeReason); } catch (error) { return Promise.reject(error); }
      return Promise.reject(new ProviderUnavailableError(
        { provider: 'codex', transport: 'control', retryable: true, sanitizedDiagnostics: { kind: 'rpc-closed' } },
        'RPC peer is closed',
      ));
    }
    if (this.#outbound.size >= this.#maxPending) {
      return Promise.reject(new ProtocolError({ provider: 'codex', retryable: true }, 'Too many pending RPC requests'));
    }
    const id = `c:${this.#epoch}:${++this.#counter}`;
    return new Promise<unknown>((resolve, reject) => {
      this.#outbound.set(idKey(id), { resolve, reject });
      void this.#write({ id, method, params }).catch((error) => {
        this.#outbound.delete(idKey(id));
        reject(error);
      });
    });
  }

  async receive(message: RpcMessage): Promise<void> {
    if (!validateEnvelope(message).valid) {
      throw new ProtocolError({ provider: 'codex', retryable: false }, 'Invalid RPC envelope');
    }
    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    const hasMethod = typeof message.method === 'string';
    if (hasId && hasMethod) {
      const id = message.id as RpcId;
      const method = message.method as string;
      if (!isServerRequestMethod(method, this.#schemaVariant)) {
        await this.#write({
          id,
          error: { code: -32601, message: `Server request method is not allowlisted: ${method}` },
        });
        return;
      }
      const validation = validateServerRequestFrame(message, this.#schemaVariant);
      if (!validation.valid) {
        await this.#write({
          id,
          error: { code: -32602, message: 'Server request failed pinned schema validation' },
        });
        throw new ProtocolError(
          {
            provider: 'codex',
            retryable: false,
            sanitizedDiagnostics: { method, validationErrors: validation.errors },
          },
          'Security-critical server request failed pinned schema validation',
        );
      }
      // Dispatch without awaiting: the handler's promise settles only when the
      // application (often a human) decides, and the receive path must keep
      // delivering notifications and responses meanwhile. Structural errors
      // (duplicate id) still reject synchronously above the dispatch.
      this.#dispatchServerRequest(id, method, message.params);
      return;
    }
    if (hasId && ('result' in message || 'error' in message)) {
      const key = idKey(message.id as RpcId);
      const pending = this.#outbound.get(key);
      if (!pending) {
        throw new ProtocolError({ provider: 'codex', retryable: false }, 'Orphan or duplicate RPC response');
      }
      this.#outbound.delete(key);
      if ('error' in message) {
        const code = typeof message.error === 'object' && message.error !== null
          ? (message.error as { code?: unknown }).code : undefined;
        const known = typeof code === 'number' && [-32700, -32600, -32601, -32602, -32603, -32000].includes(code);
        pending.reject(new ProtocolError(
          { provider: 'codex', retryable: false, sanitizedDiagnostics: { kind: 'rpc-error', ...(known ? { code } : {}) } },
          'Codex App Server returned an RPC error',
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (hasMethod) {
      await this.#onNotification?.(message.method as string, message.params);
      return;
    }
    throw new ProtocolError({ provider: 'codex', retryable: false }, 'Invalid RPC envelope');
  }

  /** Server requests received but not yet answered on the wire. */
  get inboundPending(): number {
    return this.#inbound.size;
  }

  /** Resolves once every server request dispatched so far has been answered. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  close(reason: unknown = new Error('RPC peer closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const pending of this.#outbound.values()) pending.reject(reason);
    this.#outbound.clear();
  }

  #dispatchServerRequest(id: RpcId, method: string, params: unknown): void {
    const key = idKey(id);
    if (this.#inbound.has(key)) {
      throw new ProtocolError({ provider: 'codex', retryable: false }, 'Duplicate inbound server request id');
    }
    this.#inbound.add(key);
    const work = this.#answerServerRequest(id, method, params)
      .catch((error: unknown) => { this.#onAsyncError?.(error); })
      .finally(() => {
        this.#inFlight.delete(work);
        this.#inbound.delete(key);
      });
    this.#inFlight.add(work);
  }

  async #answerServerRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    if (!this.#onServerRequest) {
      await this.#answer({
        id,
        error: { code: -32601, message: `No handler for server request ${method}` },
      });
      return;
    }
    let answer: RpcMessage;
    try {
      answer = { id, result: await this.#onServerRequest(method, params, id) };
    } catch {
      answer = { id, error: { code: -32000, message: 'Server request handler failed' } };
    }
    await this.#answer(answer);
  }

  /** A late answer after the peer closed has no wire to reach; dropping it is correct. */
  async #answer(message: RpcMessage): Promise<void> {
    if (this.#closed) return;
    await this.#write(message);
  }
}
