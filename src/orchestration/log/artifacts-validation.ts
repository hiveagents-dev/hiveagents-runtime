import { isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import { hash, identifier, object } from '../../shared/json.js';
import type { PayloadReference } from './types.js';
import { LOG_ARTIFACT_LIMITS, LogArtifactError, type LogArtifactBinding, type LogArtifactOptions, type LogArtifactReadOptions, type LogArtifactWriteOptions } from './artifacts-types.js';

const lengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const reasonGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')!.get!;
function exact(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  object(input, keys); if (keys.some(key => !optional.includes(key) && !Object.hasOwn(input, key))) throw new LogArtifactError('INVALID');
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(input)).map(([key, value]) => [key, value.value]));
}
const text = (input: unknown) => { identifier(input); if (Buffer.from(input).toString('utf8') !== input) throw new LogArtifactError('INVALID'); return input; };
function integer(input: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) throw new LogArtifactError('INVALID'); return input;
}
export function artifactOptions(input: LogArtifactOptions) {
  try {
    const r = exact(input, ['directory', 'binding', 'maxBytes', 'maxPending'], ['maxBytes', 'maxPending']), b = exact(r.binding, ['sourceId', 'systemId', 'generation']);
    if (typeof r.directory !== 'string' || !isAbsolute(r.directory) || resolve(r.directory) !== r.directory || r.directory.includes('\0') || Buffer.byteLength(r.directory) > 4096) throw Error();
    return Object.freeze({ directory: r.directory, binding: Object.freeze({ sourceId: text(b.sourceId), systemId: text(b.systemId), generation: integer(b.generation, 1) }),
      maxBytes: integer(r.maxBytes === undefined ? LOG_ARTIFACT_LIMITS.maxBytes : r.maxBytes, 1, LOG_ARTIFACT_LIMITS.maxBytes),
      maxPending: integer(r.maxPending === undefined ? 2 : r.maxPending, 1, 2) });
  } catch { throw new LogArtifactError('INVALID'); }
}
export function artifactIoOptions(input: LogArtifactReadOptions | LogArtifactWriteOptions, write = false) {
  try {
    const r = exact(input, write ? ['signal', 'mediaType'] : ['signal'], ['signal']), signal = r.signal;
    if (signal !== undefined) { if (!signal || typeof signal !== 'object' || types.isProxy(signal)) throw Error(); Reflect.apply(abortedGetter, signal, []); }
    if (write && r.mediaType !== 'application/json' && r.mediaType !== 'application/octet-stream') throw Error();
    return Object.freeze({ signal: signal as AbortSignal | undefined, mediaType: r.mediaType as PayloadReference['mediaType'] | undefined });
  } catch { throw new LogArtifactError('INVALID'); }
}
export function artifactReference(input: unknown, binding: LogArtifactBinding, maximum: number): PayloadReference {
  try {
    const r = exact(input, ['sourceId', 'systemId', 'generation', 'digest', 'bytes', 'mediaType']);
    if (r.sourceId !== binding.sourceId || r.systemId !== binding.systemId || r.generation !== binding.generation
      || r.mediaType !== 'application/json' && r.mediaType !== 'application/octet-stream') throw Error(); hash(r.digest);
    return Object.freeze({ ...binding, digest: r.digest, bytes: integer(r.bytes, 0, maximum), mediaType: r.mediaType });
  } catch { throw new LogArtifactError('INVALID'); }
}
export function artifactInputSize(input: unknown, maximum: number): number {
  if (typeof input === 'string') { const size = Buffer.byteLength(input); if (size > maximum) throw new LogArtifactError('LIMIT'); return size; }
  if (!input || typeof input !== 'object' || types.isProxy(input) || !types.isUint8Array(input)) throw new LogArtifactError('INVALID');
  const size = Reflect.apply(lengthGetter, input, []) as number, backing = Reflect.apply(bufferGetter, input, []) as unknown;
  if (types.isSharedArrayBuffer(backing)) throw new LogArtifactError('INVALID'); if (size > maximum) throw new LogArtifactError('LIMIT'); return size;
}
export function captureArtifactInput(input: string | Uint8Array, length: number): string | Buffer {
  if (typeof input === 'string') return input;
  try { const bytes = Buffer.allocUnsafe(length); Uint8Array.prototype.set.call(bytes, input); return bytes; }
  catch { throw new LogArtifactError('INVALID'); }
}
export function checkArtifactAbort(signal?: AbortSignal): void {
  if (signal && Reflect.apply(abortedGetter, signal, [])) throw new LogArtifactError('ABORTED', Reflect.apply(reasonGetter, signal, []));
}
export function* artifactChunks(input: string | Buffer): Generator<Buffer> {
  if (typeof input !== 'string') { for (let offset = 0; offset < input.length; offset += LOG_ARTIFACT_LIMITS.chunkBytes) yield input.subarray(offset, offset + LOG_ARTIFACT_LIMITS.chunkBytes); return; }
  for (let offset = 0; offset < input.length;) {
    let end = Math.min(input.length, offset + 16384); const tail = input.charCodeAt(end - 1);
    if (end < input.length && tail >= 0xd800 && tail <= 0xdbff) end--;
    if (end === offset) end++;
    const slice = input.slice(offset, end), bytes = Buffer.from(slice); if (bytes.toString('utf8') !== slice) throw new LogArtifactError('INVALID');
    yield bytes; offset = end;
  }
}
export const artifactFailure = (cause: unknown) => cause instanceof LogArtifactError ? cause : new LogArtifactError('IO', cause);
export const artifactYield = () => new Promise<void>(resolve => setImmediate(resolve));
