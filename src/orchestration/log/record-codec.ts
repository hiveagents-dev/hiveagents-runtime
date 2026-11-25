import { types } from 'node:util';
import { hash, method, object } from '../../shared/json.js';
import { isExecutionHalted } from '../../public/execution-halt.js';
import { captureLogCommit } from './validation.js';
import { captureRecordJson, decodeRecordJson, encodeRecordJson } from './record-json.js';
import { executionFailure } from './execution-types.js';
import type { ExecutionArtifactStore } from './execution-types.js';
import type { LogJsonValue, PayloadReference, RunIdentity } from './types.js';
export interface RecordBody { readonly codec: 'oar.execution.record-json'; readonly version: 1; readonly reference: PayloadReference }
export function captureRecordBody(input: unknown, sourceId: string, identity: RunIdentity, maxBytes: number): RecordBody {
  try {
    object(input, ['codec', 'version', 'reference']); if (Object.keys(input).length !== 3 || input.codec !== 'oar.execution.record-json' || input.version !== 1) executionFailure('PAYLOAD_UNAVAILABLE');
    const checked = captureLogCommit({ requestId: 'reference', records: [{ identity, schema: { id: 'reference', version: 1 }, type: 'reference', causal: [], payload: { artifact: input.reference } }] });
    const reference = (checked.records[0]!.payload as { artifact: PayloadReference }).artifact;
    if (reference.sourceId !== sourceId || reference.bytes > maxBytes || reference.mediaType !== 'application/json') executionFailure('PAYLOAD_UNAVAILABLE');
    return Object.freeze({ codec: 'oar.execution.record-json', version: 1, reference });
  } catch { return executionFailure('PAYLOAD_UNAVAILABLE'); }
}
/** Captured trusted content port only; no execution, recovery, GC or permission callback. */
export class RecordCodec {
  readonly maxBytes: number; readonly port: ExecutionArtifactStore | undefined;
  readonly #controller = new AbortController(); #pending = 0;
  constructor(input: ExecutionArtifactStore | undefined, maxBytes = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > 128 * 1024 * 1024) executionFailure('INVALID_STATE');
    this.maxBytes = maxBytes;
    try { this.port = input ? Object.freeze({ write: method(input, 'write'), read: method(input, 'read'), verify: method(input, 'verify') }) as ExecutionArtifactStore : undefined; }
    catch { return executionFailure('INVALID_STATE'); }
  }
  close(): void { this.#controller.abort(); }
  async operation<T>(body: () => Promise<T>): Promise<T> {
    if (this.#controller.signal.aborted) executionFailure('CLOSED'); if (this.#pending >= 2) executionFailure('CODEC_BUSY'); this.#pending++;
    try { return await body(); } finally { this.#pending--; }
  }
  capture(input: unknown, check: () => void): Promise<LogJsonValue> { return captureRecordJson(input, { maxBytes: this.maxBytes }, check); }
  encode(input: LogJsonValue, check: () => void) { return encodeRecordJson(input, { maxBytes: this.maxBytes }, check); }
  async stage(bytes: Buffer, digest: string, sourceId: string, identity: RunIdentity, check: () => void): Promise<RecordBody> {
    if (!this.port) executionFailure('PAYLOAD_CODEC_REQUIRED');
    try {
      const reference = await this.port.write(bytes, { mediaType: 'application/json', signal: this.#controller.signal }); check();
      const body = captureRecordBody({ codec: 'oar.execution.record-json', version: 1, reference }, sourceId, identity, this.maxBytes);
      if (body.reference.bytes !== bytes.length || body.reference.digest !== digest) executionFailure('PAYLOAD_UNAVAILABLE');
      return body;
    } catch (error) { return this.#failure(error, check); }
  }
  async hydrate(body: RecordBody, digest: string, check: () => void): Promise<LogJsonValue> {
    if (!this.port) executionFailure('PAYLOAD_CODEC_REQUIRED'); hash(digest); if (body.reference.digest !== digest) executionFailure('PAYLOAD_UNAVAILABLE');
    let owned: Buffer | undefined;
    try {
      const bytes = await this.port.read(body.reference, { signal: this.#controller.signal }); check();
      if (types.isProxy(bytes) || !types.isUint8Array(bytes)) executionFailure('PAYLOAD_UNAVAILABLE');
      const length = Reflect.apply(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!, bytes, []) as number;
      if (length !== body.reference.bytes || length > this.maxBytes) executionFailure('CODEC_LIMIT');
      owned = Buffer.allocUnsafe(length); Reflect.apply(Uint8Array.prototype.set, owned, [bytes]);
      const record = await decodeRecordJson(owned, digest, { maxBytes: this.maxBytes }, check); check(); return record;
    } catch (error) { return this.#failure(error, check); }
    finally { owned?.fill(0); }
  }
  async verify(reference: PayloadReference, options?: { signal?: AbortSignal }) {
    if (!this.port) executionFailure('PAYLOAD_CODEC_REQUIRED'); return this.port.verify(reference, options);
  }
  #failure(error: unknown, check: () => void): never {
    try { check(); } catch (secondary) {
      if (isExecutionHalted(error)) throw new AggregateError([error, secondary], 'Execution halted during body validation', { cause: error });
      throw secondary;
    }
    if (isExecutionHalted(error)) throw error; return executionFailure('PAYLOAD_UNAVAILABLE');
  }
}
