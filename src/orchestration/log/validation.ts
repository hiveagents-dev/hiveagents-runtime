import { types } from 'node:util';
import { canonical, freeze, hash, identifier, jsonClone, object } from '../../shared/json.js';
import type { LogCommit } from './types.js';

export const LOG_FORMAT_LIMITS = Object.freeze({ depth: 64, nodes: 65536, records: 256, causal: 64,
  envelopeBytes: 16384, inlineBytes: 65536, batchInlineBytes: 1048576, batchBytes: 6 * 1048576 });
function invalid(): never { throw new TypeError('Invalid execution log data'); }
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function bounded(input: unknown): void {
  let nodes = 0, bytes = 0; const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (++nodes > LOG_FORMAT_LIMITS.nodes || depth > LOG_FORMAT_LIMITS.depth) invalid();
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value); if (bytes > LOG_FORMAT_LIMITS.batchBytes || Buffer.from(value).toString('utf8') !== value) invalid(); return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
    if (Array.isArray(value) && value.length > LOG_FORMAT_LIMITS.nodes) invalid();
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    if (Object.getOwnPropertySymbols(value).length) invalid();
    ancestors.add(value);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
      bytes += Buffer.byteLength(key); if (bytes > LOG_FORMAT_LIMITS.batchBytes || Buffer.from(key).toString('utf8') !== key) invalid(); visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
}
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  object(value, fields); if (fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function positive(value: unknown, zero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) invalid();
}
/** Strict data capture only. Payload-schema support and execution authority are checked by later consumers. */
export function captureLogCommit(input: unknown): LogCommit {
  try {
    bounded(input); const commit = jsonClone(input); closed(commit, ['requestId', 'records']); identifier(commit.requestId);
    if (!Array.isArray(commit.records) || !commit.records.length || commit.records.length > LOG_FORMAT_LIMITS.records) invalid();
    let totalInline = 0;
    for (const draft of commit.records) {
      closed(draft, ['identity', 'schema', 'type', 'causal', 'payload']); identifier(draft.type);
      closed(draft.identity, ['systemId', 'generation', 'runId', 'agentId', 'harness']);
      for (const key of ['systemId', 'runId', 'agentId']) identifier(draft.identity[key]); positive(draft.identity.generation);
      closed(draft.identity.harness, ['id', 'version', 'digest']); identifier(draft.identity.harness.id); identifier(draft.identity.harness.version); hash(draft.identity.harness.digest);
      closed(draft.schema, ['id', 'version']); identifier(draft.schema.id); positive(draft.schema.version);
      if (!Array.isArray(draft.causal) || draft.causal.length > LOG_FORMAT_LIMITS.causal) invalid();
      for (const position of draft.causal) { closed(position, ['sourceId', 'sequence', 'digest']); identifier(position.sourceId); positive(position.sequence); hash(position.digest); }
      object(draft.payload, ['inline', 'artifact']);
      if (Object.keys(draft.payload).length !== 1) invalid();
      if (Object.hasOwn(draft.payload, 'inline')) {
        const bytes = Buffer.byteLength(canonical(draft.payload.inline)); totalInline += bytes;
        if (bytes > LOG_FORMAT_LIMITS.inlineBytes || totalInline > LOG_FORMAT_LIMITS.batchInlineBytes) invalid();
      } else {
        const ref = draft.payload.artifact; closed(ref, ['sourceId', 'systemId', 'generation', 'digest', 'bytes', 'mediaType']);
        identifier(ref.sourceId); identifier(ref.systemId); positive(ref.generation); positive(ref.bytes, true); hash(ref.digest);
        if (ref.systemId !== draft.identity.systemId || ref.generation !== draft.identity.generation
          || ref.mediaType !== 'application/json' && ref.mediaType !== 'application/octet-stream') invalid();
      }
      const { payload: _, ...envelope } = draft;
      if (Buffer.byteLength(canonical(envelope)) > LOG_FORMAT_LIMITS.envelopeBytes) invalid();
    }
    if (Buffer.byteLength(canonical(commit)) > LOG_FORMAT_LIMITS.batchBytes) invalid();
    return freeze(commit) as unknown as LogCommit;
  } catch { return invalid(); }
}
export function encodeLogCommit(input: unknown): string { return canonical(captureLogCommit(input)); }
export function decodeLogCommit(input: string | Uint8Array): LogCommit {
  try {
    if (typeof input !== 'string' && (types.isProxy(input) || !types.isUint8Array(input))) invalid();
    if (typeof input === 'string' ? Buffer.byteLength(input) > LOG_FORMAT_LIMITS.batchBytes : Reflect.apply(byteLength, input, []) > LOG_FORMAT_LIMITS.batchBytes) invalid();
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    const value = captureLogCommit(JSON.parse(text)); if (canonical(value) !== text) invalid(); return value;
  } catch { return invalid(); }
}
