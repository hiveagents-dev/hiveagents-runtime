import { isAbsolute, resolve } from 'node:path';
import { canonical, hash, identifier, jsonClone, ownObject } from '../../shared/json.js';
import type { LogCursor } from '../log/store-types.js';
import type { LogPosition } from '../log/types.js';
import type { JsonValue } from '../workflow/types.js';
import { assertMemoryGateEvidence } from './gate.js';
import type { MemoryGateEvidence } from './gate.js';
import type { EmbeddingIdentity, MemoryProvenance } from './ports.js';
import { MAX_LESSONS_CEILING, MAX_LESSONS_PER_RECALL, MemoryStoreError, isMemoryStoreError } from './store-types.js';

/**
 * Boundary validation. Every public call captures its input here first: own data
 * properties only, no unknown fields, bounded sizes. Anything else is refused
 * with INVALID_INPUT before the database is touched.
 */

const MAX_TEXT = 8192;
const MAX_QUERY_TEXT = 4096;
const MAX_REASON = 512;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_DIMENSIONS = 8192;
/** Lessons one record may supersede. */
export const MAX_SUPERSEDES = 32;
/** A strict ISO-8601 instant: date, time to the minute at least, and an offset. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A scope as stored: an absent subject is the empty string, which no identifier can be. */
export interface CapturedScope { tenant: string; namespace: string; subject: string }
export interface CapturedEmbedding { identity: EmbeddingIdentity; identityKey: string; values: number[] }
export interface CapturedRecord {
  id: string;
  scope: CapturedScope;
  text: string;
  provenance: MemoryProvenance;
  metadata?: JsonValue;
  embedding?: CapturedEmbedding;
  supersedes?: string[];
  /** In UTC, as `toISOString()` gives it. */
  validUntil?: string;
}
export interface CapturedOptions {
  databasePath: string;
  systemId: string;
  busyTimeoutMs: number;
  maxLessonsPerRecall: number;
  now: () => string;
}
export interface CapturedLogSearch {
  text: string;
  limit: number;
  maxScanned: number;
  filter: { runId?: string; agentId?: string; generation?: number };
  cursor?: LogCursor;
}

function invalid(): never {
  throw new MemoryStoreError('INVALID_INPUT');
}

/** Runs a capture; whatever it throws surfaces as INVALID_INPUT with no caller data in it. */
function captured<T>(capture: () => T): T {
  try {
    return capture();
  } catch (error) {
    if (isMemoryStoreError(error)) throw error;
    return invalid();
  }
}

function integer(value: unknown, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum) invalid();
  if (!allowEmpty && !(value as string).trim()) invalid();
  return value as string;
}

/** Control, format and line-separator characters. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A system id, namespace, subject, record id or actor. These are written to audit
 * fields and shown on a console, so beyond the shared identifier rule (nonblank,
 * at most 128 characters) they may not carry unprintable characters or edge
 * whitespace. Any script and ordinary punctuation are fine.
 */
function name(value: unknown): string {
  identifier(value);
  if (UNPRINTABLE.test(value) || value !== value.trim()) invalid();
  return value;
}

export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) invalid();
  if (Number.isNaN(Date.parse(value as string))) invalid();
  return value as string;
}

/** A strict ISO-8601 instant, returned in UTC as `toISOString()` gives it, so instants compare as strings. */
export function instant(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !INSTANT.test(value)) invalid();
  const time = Date.parse(value as string);
  if (Number.isNaN(time)) invalid();
  return new Date(time).toISOString();
}

/** Any accepted timestamp (the injectable clock's), in the same UTC form as `instant`. */
export function utc(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

/** The form every timestamp is stored in: UTC, milliseconds, as `toISOString()` gives it. */
const STORED_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A timestamp as any build may have stored it, read as an instant in the stored UTC form. This
 * build stores nothing else, but a file written before it, or by an older build on the same
 * machine, can hold the injectable clock's raw string with a UTC offset; ordering such strings
 * as text is not chronological. A value no date parser reads is returned unchanged.
 */
export function storedInstant(value: string): string {
  if (STORED_UTC.test(value)) return value;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** Ids of the same scope, at least one, at most `MAX_SUPERSEDES`, no repeats and never the record's own id. */
function supersedesOf(value: unknown, own: string): string[] {
  const ids = jsonClone(value) as unknown;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SUPERSEDES) invalid();
  const names = (ids as unknown[]).map(name);
  if (new Set(names).size !== names.length || names.includes(own)) invalid();
  return names;
}

function signalOf(value: unknown): AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) invalid();
  return value as AbortSignal | undefined;
}

function scopeOf(value: unknown): CapturedScope {
  const scope = ownObject(value as Record<string, unknown>, ['tenant', 'namespace', 'subject']);
  return {
    tenant: name(scope.tenant),
    namespace: name(scope.namespace),
    subject: scope.subject === undefined ? '' : name(scope.subject),
  };
}

function positionOf(value: unknown): LogPosition {
  const position = ownObject(value as Record<string, unknown>, ['sourceId', 'sequence', 'digest']);
  hash(position.digest);
  return {
    sourceId: name(position.sourceId),
    sequence: integer(position.sequence, 1, Number.MAX_SAFE_INTEGER),
    digest: position.digest,
  };
}

/** Provenance is mandatory and must point at a source: a log position, an input hash, or both. */
function provenanceOf(value: unknown): MemoryProvenance {
  const input = ownObject(value as Record<string, unknown>, ['source', 'sourceVersion', 'observedAt', 'inputHash', 'logPosition']);
  const provenance: MemoryProvenance = {
    source: name(input.source),
    sourceVersion: name(input.sourceVersion),
    observedAt: timestamp(input.observedAt),
  };
  if (input.inputHash !== undefined) {
    hash(input.inputHash);
    provenance.inputHash = input.inputHash;
  }
  if (input.logPosition !== undefined) provenance.logPosition = positionOf(input.logPosition);
  if (provenance.inputHash === undefined && provenance.logPosition === undefined) invalid();
  return provenance;
}

function embeddingOf(value: unknown): CapturedEmbedding {
  const input = ownObject(value as Record<string, unknown>, ['identity', 'values']);
  const raw = ownObject(input.identity as Record<string, unknown>, ['provider', 'model', 'revision', 'dimensions']);
  const identity: EmbeddingIdentity = {
    provider: name(raw.provider),
    model: name(raw.model),
    revision: name(raw.revision),
    dimensions: integer(raw.dimensions, 1, MAX_DIMENSIONS),
  };
  const values = jsonClone(input.values) as unknown;
  if (!Array.isArray(values) || values.length !== identity.dimensions) invalid();
  if ((values as unknown[]).some(entry => typeof entry !== 'number')) invalid();
  return { identity, identityKey: canonical(identity), values: values as number[] };
}

export function captureOptions(value: unknown): CapturedOptions {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['databasePath', 'systemId', 'busyTimeoutMs', 'maxLessonsPerRecall', 'now']);
    const path = input.databasePath;
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) invalid();
    if (input.now !== undefined && typeof input.now !== 'function') invalid();
    return {
      databasePath: path as string,
      systemId: name(input.systemId),
      busyTimeoutMs: integer(input.busyTimeoutMs, 0, 60_000, 5000),
      maxLessonsPerRecall: integer(input.maxLessonsPerRecall, 1, MAX_LESSONS_CEILING, MAX_LESSONS_PER_RECALL),
      now: (input.now as (() => string) | undefined) ?? (() => new Date().toISOString()),
    };
  });
}

export function captureActor(value: unknown): string {
  return captured(() => name(ownObject(value as Record<string, unknown>, ['by']).by));
}

export function captureSignal(value: unknown): AbortSignal | undefined {
  return captured(() => signalOf(value));
}

export function captureRecord(value: unknown): CapturedRecord {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, [
      'id', 'scope', 'text', 'provenance', 'metadata', 'embedding', 'revokedAt', 'supersedes', 'validUntil',
    ]);
    // A record is withdrawn through revoke(), never stored already revoked.
    if (input.revokedAt !== undefined) invalid();
    const record: CapturedRecord = {
      id: name(input.id),
      scope: scopeOf(input.scope),
      text: boundedText(input.text, MAX_TEXT),
      provenance: provenanceOf(input.provenance),
    };
    if (input.metadata !== undefined) {
      const metadata = jsonClone(input.metadata) as JsonValue;
      if (Buffer.byteLength(canonical(metadata)) > MAX_METADATA_BYTES) invalid();
      record.metadata = metadata;
    }
    if (input.embedding !== undefined) record.embedding = embeddingOf(input.embedding);
    if (input.supersedes !== undefined) record.supersedes = supersedesOf(input.supersedes, record.id);
    if (input.validUntil !== undefined) record.validUntil = instant(input.validUntil);
    return record;
  });
}

export function captureRevocation(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['scope', 'id', 'revokedAt', 'reason']);
    return {
      scope: scopeOf(input.scope),
      id: name(input.id),
      revokedAt: utc(timestamp(input.revokedAt)),
      reason: boundedText(input.reason, MAX_REASON),
    };
  });
}

export function captureLookup(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['scope', 'id', 'signal']);
    return { scope: scopeOf(input.scope), id: name(input.id), signal: signalOf(input.signal) };
  });
}

export function captureQuery(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['scope', 'text', 'limit', 'embedding', 'signal']);
    return {
      scope: scopeOf(input.scope),
      text: boundedText(input.text, MAX_QUERY_TEXT, true),
      limit: integer(input.limit, 0, 1000),
      embedding: input.embedding === undefined ? undefined : embeddingOf(input.embedding),
      signal: signalOf(input.signal),
    };
  });
}

export function captureList(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['scope', 'limit']);
    return { scope: scopeOf(input.scope), limit: integer(input.limit, 1, 256, 64) };
  });
}

export function capturePromotion(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['scope', 'id', 'gate', 'by']);
    const gate: MemoryGateEvidence = assertMemoryGateEvidence(jsonClone(input.gate));
    return { scope: scopeOf(input.scope), id: name(input.id), gate, by: name(input.by) };
  });
}

export function captureRollback(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['scope', 'id', 'by', 'reason']);
    return {
      scope: scopeOf(input.scope),
      id: name(input.id),
      by: name(input.by),
      reason: boundedText(input.reason, MAX_REASON),
    };
  });
}

export function captureGrant(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['to', 'namespace', 'subject', 'by']);
    return {
      to: name(input.to),
      namespace: name(input.namespace),
      subject: input.subject === undefined ? '' : name(input.subject),
      by: name(input.by),
    };
  });
}

export function captureGrantRevocation(value: unknown) {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['id', 'by']);
    return { id: name(input.id), by: name(input.by) };
  });
}

export function captureLogSearch(value: unknown): CapturedLogSearch {
  return captured(() => {
    const input = ownObject(value as Record<string, unknown>, ['text', 'limit', 'maxScanned', 'runId', 'agentId', 'generation', 'cursor']);
    const filter: CapturedLogSearch['filter'] = {};
    if (input.runId !== undefined) filter.runId = name(input.runId);
    if (input.agentId !== undefined) filter.agentId = name(input.agentId);
    if (input.generation !== undefined) filter.generation = integer(input.generation, 1, Number.MAX_SAFE_INTEGER);
    const search: CapturedLogSearch = {
      text: boundedText(input.text, MAX_QUERY_TEXT, true),
      limit: integer(input.limit, 1, 50, 5),
      maxScanned: integer(input.maxScanned, 1, 8192, 2048),
      filter,
    };
    // The log store validates the cursor itself; here it only has to be plain data.
    if (input.cursor !== undefined) search.cursor = jsonClone(input.cursor) as LogCursor;
    return search;
  });
}
