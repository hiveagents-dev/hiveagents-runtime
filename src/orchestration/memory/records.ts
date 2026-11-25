import { canonical, digest, freeze } from '../../shared/json.js';
import type { JsonValue } from '../workflow/types.js';
import type { MemoryGateEvidence } from './gate.js';
import type { EmbeddingIdentity, MemoryProvenance, MemoryScope, ScopedMemoryRecord } from './ports.js';
import type { MemoryGrant, MemoryRecordState, MemoryRecordView } from './store-types.js';
import { storedInstant } from './validation.js';
import type { CapturedRecord, CapturedScope } from './validation.js';

/** A row of `memory_records` (or of the `memory_readable` view) as SQLite returns it. */
export interface RecordRow {
  tenant: string;
  namespace: string;
  subject: string;
  id: string;
  text: string;
  content_digest: string;
  provenance_json: string;
  source_id: string | null;
  source_sequence: number | null;
  metadata_json: string | null;
  embedding_identity: string | null;
  embedding_json: string | null;
  recorded_at: string;
  promoted_at: string | null;
  promoted_by: string | null;
  gate_json: string | null;
  rolled_back_at: string | null;
  revoked_at: string | null;
  /** The temporal columns: the record's `supersedes` as JSON, its `validUntil` in UTC, and the final invalidation. */
  supersedes_json: string | null;
  valid_until: string | null;
  invalidated_at: string | null;
  invalidated_by: string | null;
}

export interface GrantRow {
  grant_id: string;
  owner: string;
  grantee: string;
  namespace: string;
  subject: string;
  granted_by: string;
  granted_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
}

export function publicScope(scope: CapturedScope): MemoryScope {
  const result: MemoryScope = { tenant: scope.tenant, namespace: scope.namespace };
  if (scope.subject !== '') result.subject = scope.subject;
  return result;
}

/** Binds everything an episode says, so "same id, same content" can be told from a rewrite. */
export function contentDigest(record: CapturedRecord): string {
  return digest({
    scope: record.scope,
    id: record.id,
    text: record.text,
    provenance: record.provenance,
    metadata: record.metadata ?? null,
    embedding: record.embedding ? { identity: record.embedding.identity, values: record.embedding.values } : null,
    // Only when present, so that every record stored before the temporal columns keeps its digest.
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    ...(record.validUntil ? { validUntil: record.validUntil } : {}),
  });
}

/** Column values for one new episode, in the order of `INSERT_RECORD`. */
export function insertValues(record: CapturedRecord, recordedAt: string): (string | number | null)[] {
  const position = record.provenance.logPosition;
  return [
    record.scope.tenant,
    record.scope.namespace,
    record.scope.subject,
    record.id,
    record.text,
    contentDigest(record),
    canonical(record.provenance),
    position?.sourceId ?? null,
    position?.sequence ?? null,
    position?.digest ?? null,
    record.provenance.inputHash ?? null,
    record.metadata === undefined ? null : canonical(record.metadata),
    record.embedding?.identityKey ?? null,
    record.embedding ? JSON.stringify(record.embedding.values) : null,
    recordedAt,
    record.supersedes ? JSON.stringify(record.supersedes) : null,
    record.validUntil ?? null,
  ];
}

export const INSERT_RECORD = `
INSERT INTO memory_records (
  tenant, namespace, subject, id, text, content_digest, provenance_json, source_id, source_sequence,
  source_digest, input_hash, metadata_json, embedding_identity, embedding_json, recorded_at,
  supersedes_json, valid_until
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function toRecord(row: RecordRow): ScopedMemoryRecord {
  const record: ScopedMemoryRecord = {
    id: row.id,
    scope: publicScope(row),
    text: row.text,
    provenance: JSON.parse(row.provenance_json) as MemoryProvenance,
  };
  if (row.metadata_json !== null) record.metadata = JSON.parse(row.metadata_json) as JsonValue;
  if (row.embedding_identity !== null && row.embedding_json !== null) {
    record.embedding = {
      identity: JSON.parse(row.embedding_identity) as EmbeddingIdentity,
      values: JSON.parse(row.embedding_json) as number[],
    };
  }
  if (row.supersedes_json !== null) record.supersedes = JSON.parse(row.supersedes_json) as string[];
  if (row.valid_until !== null) record.validUntil = row.valid_until;
  return freeze(record);
}

/** Invalidation is final and wins; expiry is judged at `now` (UTC, as `toISOString()` gives it). */
export function stateOf(row: RecordRow, now: string): MemoryRecordState {
  if (row.invalidated_at !== null) return 'invalidated';
  if (row.valid_until !== null && row.valid_until < now) return 'expired';
  return row.promoted_at === null ? 'episode' : 'lesson';
}

/**
 * Timestamps are returned in UTC as `toISOString()` gives them, also those an older build stored
 * with the clock's UTC offset (see `storedInstant`).
 */
export function toView(row: RecordRow, now: string): MemoryRecordView {
  const view: MemoryRecordView = {
    record: toRecord(row),
    state: stateOf(row, now),
    contentDigest: row.content_digest,
    recordedAt: storedInstant(row.recorded_at),
  };
  if (row.promoted_at !== null && row.promoted_by !== null && row.gate_json !== null) {
    view.promotion = {
      promotedAt: storedInstant(row.promoted_at),
      promotedBy: row.promoted_by,
      gate: JSON.parse(row.gate_json) as MemoryGateEvidence,
    };
  }
  if (row.invalidated_at !== null && row.invalidated_by !== null) {
    view.invalidation = { invalidatedAt: storedInstant(row.invalidated_at), supersededBy: row.invalidated_by };
  }
  return freeze(view);
}

export function toGrant(row: GrantRow): MemoryGrant {
  const grant: MemoryGrant = {
    id: row.grant_id,
    owner: row.owner,
    grantee: row.grantee,
    namespace: row.namespace,
    grantedBy: row.granted_by,
    grantedAt: storedInstant(row.granted_at),
  };
  if (row.subject !== '') grant.subject = row.subject;
  if (row.revoked_by !== null) grant.revokedBy = row.revoked_by;
  if (row.revoked_at !== null) grant.revokedAt = storedInstant(row.revoked_at);
  return freeze(grant);
}
