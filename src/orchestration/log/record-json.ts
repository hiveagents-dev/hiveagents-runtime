import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import { executionFailure } from './execution-types.js';
import type { LogJsonValue } from './types.js';
export interface RecordJsonLimits { readonly maxBytes: number }
const MAX_NODES = 65536, MAX_DEPTH = 64, CHUNK = 65536;
async function pause(check: () => void): Promise<void> { await setImmediate(); check(); }
/** Data capture only; immutable original property order preserves legacy JSON.stringify hashes. */
export async function captureRecordJson(input: unknown, limits: RecordJsonLimits, check: () => void): Promise<LogJsonValue> {
  let nodes = 0, bytes = 0; const ancestors = new Set<object>();
  async function visit(value: unknown, depth: number): Promise<LogJsonValue> {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) executionFailure('CODEC_LIMIT');
    if (nodes % 256 === 0) await pause(check);
    if (typeof value === 'string') { if (/[\ud800-\udfff]/u.test(value)) executionFailure('INVALID_STATE'); bytes += Buffer.byteLength(value); if (bytes > limits.maxBytes) executionFailure('CODEC_LIMIT'); return value; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) executionFailure('INVALID_STATE');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) executionFailure('INVALID_STATE');
    const names = Object.getOwnPropertyNames(value); if (names.length > MAX_NODES + 1 || array && names.length !== value.length + 1) executionFailure('CODEC_LIMIT');
    const captured: Record<string, LogJsonValue> | LogJsonValue[] = array ? [] : Object.create(null); ancestors.add(value); let index = 0;
    try {
      for (const key of names) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (array && key !== String(index++) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) executionFailure('INVALID_STATE');
        if (/[\ud800-\udfff]/u.test(key)) executionFailure('INVALID_STATE'); bytes += Buffer.byteLength(key); if (bytes > limits.maxBytes) executionFailure('CODEC_LIMIT');
        const child = await visit(descriptor.value, depth + 1); check(); Object.defineProperty(captured, key, { value: child, enumerable: true });
      }
      return Object.freeze(captured);
    } finally { ancestors.delete(value); }
  }
  check(); const captured = await visit(input, 1); check(); return captured;
}
function* quoted(value: string): Generator<string> {
  if (/[\ud800-\udfff]/u.test(value)) executionFailure('INVALID_STATE');
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + 4096);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
  }
  yield '"';
}
function* fragments(value: LogJsonValue): Generator<string> {
  if (typeof value === 'string') { yield* quoted(value); return; }
  if (value === null || typeof value !== 'object') { yield JSON.stringify(value); return; }
  const array = Array.isArray(value); yield array ? '[' : '{'; let first = true;
  for (const key of Object.keys(value)) {
    if (!first) yield ','; first = false;
    if (!array) { yield* quoted(key); yield ':'; }
    yield* fragments((value as Record<string, LogJsonValue>)[key]!);
  }
  yield array ? ']' : '}';
}
async function encode(value: LogJsonValue, limits: RecordJsonLimits, check: () => void, retain: boolean) {
  const chunks: Buffer[] = [], hash = createHash('sha256'); let total = 0, buffer = Buffer.allocUnsafe(CHUNK), used = 0;
  for (const text of fragments(value)) {
    const bytes = Buffer.from(text); total += bytes.length; if (total > limits.maxBytes) executionFailure('CODEC_LIMIT');
    for (let offset = 0; offset < bytes.length;) {
      const copied = Math.min(bytes.length - offset, CHUNK - used); bytes.copy(buffer, used, offset, offset + copied); used += copied; offset += copied;
      if (used === CHUNK) { hash.update(buffer); if (retain) chunks.push(buffer); await pause(check); buffer = Buffer.allocUnsafe(CHUNK); used = 0; }
    }
  }
  if (used) { hash.update(buffer.subarray(0, used)); if (retain) chunks.push(buffer.subarray(0, used)); await pause(check); }
  return { digest: hash.digest('hex'), bytes: retain ? Buffer.concat(chunks, total) : undefined, length: total };
}
export async function encodeRecordJson(value: LogJsonValue, limits: RecordJsonLimits, check: () => void): Promise<{ digest: string; bytes: Buffer }> {
  const encoded = await encode(value, limits, check, true); return { digest: encoded.digest, bytes: encoded.bytes! };
}
/** Fuse JSON nesting/tokens before JSON.parse allocates the materialized checkpoint. */
async function preflight(text: string, check: () => void): Promise<void> {
  let depth = 0, tokens = 0, string = false, escaped = false, literal = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (string) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') string = false; }
    else if (char === '"') { string = true; literal = false; tokens++; }
    else if (char === '{' || char === '[') { if (++depth > MAX_DEPTH) executionFailure('CODEC_LIMIT'); tokens++; literal = false; }
    else if (char === '}' || char === ']') { if (--depth < 0) executionFailure('INVALID_STATE'); literal = false; }
    else if (char === ',' || char === ':' || char === ' ' || char === '\r' || char === '\n' || char === '\t') literal = false;
    else if (!literal) { tokens++; literal = true; }
    if (tokens > MAX_NODES * 2) executionFailure('CODEC_LIMIT');
    if (index && index % CHUNK === 0) await pause(check);
  }
  if (depth || string || escaped) executionFailure('INVALID_STATE');
}
export async function decodeRecordJson(bytes: Uint8Array, expectedDigest: string, limits: RecordJsonLimits, check: () => void): Promise<LogJsonValue> {
  if (types.isProxy(bytes) || !types.isUint8Array(bytes)) executionFailure('PAYLOAD_UNAVAILABLE');
  const length = Reflect.apply(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!, bytes, []) as number;
  if (length > limits.maxBytes) executionFailure('CODEC_LIMIT');
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return executionFailure('PAYLOAD_UNAVAILABLE'); }
  await preflight(text, check); check();
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return executionFailure('PAYLOAD_UNAVAILABLE'); }
  const captured = await captureRecordJson(parsed, limits, check), encoded = await encode(captured, limits, check, false);
  // Detect duplicate keys/whitespace/unknown representation, preserving original insertion-order bytes.
  if (encoded.digest !== expectedDigest || encoded.length !== length) executionFailure('PAYLOAD_UNAVAILABLE');
  return captured;
}
