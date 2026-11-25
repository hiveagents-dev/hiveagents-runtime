import type { LogCursor, LogEntry } from '../log/store-types.js';
import type { LogPosition } from '../log/types.js';
import type { MemoryGateEvidence, MemoryGateRefusal } from './gate.js';
import type { MemoryScope, ScopedMemoryRecord } from './ports.js';

/** Default and hard ceiling for lessons delivered by one recall. */
export const MAX_LESSONS_PER_RECALL = 3;
export const MAX_LESSONS_CEILING = 8;

export interface SystemMemoryOptions {
  /** Absolute path of the shared memory database. Created on first use, never reset. */
  databasePath: string;
  /**
   * The system this handle acts as. The store trusts the id its host binds here:
   * it scopes and audits, it does not authenticate the caller.
   */
  systemId: string;
  /** SQLite busy timeout in milliseconds. Default: 5000. */
  busyTimeoutMs?: number;
  /** Lessons delivered per recall, 1 to 8. Default: 3. */
  maxLessonsPerRecall?: number;
  /** ISO-8601 clock, injectable for tests. Default: the system clock. */
  now?: () => string;
}

/** Who performed an administrative change. Recorded, not authenticated. */
export interface MemoryActor {
  by: string;
}

export interface MemoryStatus {
  systemId: string;
  /** False until the system enables memory; while false every read is empty and writes are refused. */
  enabled: boolean;
  changedBy?: string;
  changedAt?: string;
}

export interface MemoryListQuery {
  scope: MemoryScope;
  /** 1 to 256. Default: 64. */
  limit?: number;
}

/**
 * What recall does with a stored record right now:
 * - `episode`: stored, never promoted; not recalled until a measured gate promotes it.
 * - `lesson`: promoted; recalled.
 * - `invalidated`: was a lesson, retired by a promoted record that supersedes it (`invalidation`
 *   says which and when). Final.
 * - `expired`: its `validUntil` had passed when it was listed; never recalled, never promoted.
 *   `promotion` says whether it had been a lesson.
 */
export type MemoryRecordState = 'episode' | 'lesson' | 'invalidated' | 'expired';

/** A stored observation as its owner sees it. Withdrawn (revoked, rolled back) records are not listed. */
export interface MemoryRecordView {
  record: ScopedMemoryRecord;
  state: MemoryRecordState;
  /**
   * SHA-256 over scope, id, text, provenance, metadata and embedding, and also over
   * `supersedes` and `validUntil` when the record has them (a record without them keeps
   * the digest it had before they existed). It is what a measurement names as its
   * candidate, and what `promote` looks for in the gate: evidence for a record binds
   * what it names to retire, though the measurement does not measure that retirement.
   */
  contentDigest: string;
  recordedAt: string;
  promotion?: { promotedAt: string; promotedBy: string; gate: MemoryGateEvidence };
  /** Set when a promoted record of the same scope that supersedes this lesson retired it. */
  invalidation?: { invalidatedAt: string; supersededBy: string };
}

export interface MemoryPromotion {
  scope: MemoryScope;
  id: string;
  /** The measured comparison that justifies recalling this record; it must name the record's content digest. */
  gate: MemoryGateEvidence;
  by: string;
}

export type MemoryPromotionResult =
  | { promoted: true; promotedAt: string }
  | { promoted: false; reason: MemoryGateRefusal };

export interface MemoryRollback {
  scope: MemoryScope;
  id: string;
  by: string;
  reason: string;
}

export interface MemoryGrantRequest {
  /** The system that may recall the owner's lessons in this exact scope. */
  to: string;
  namespace: string;
  subject?: string;
  by: string;
}

export interface MemoryGrant {
  id: string;
  owner: string;
  grantee: string;
  namespace: string;
  subject?: string;
  grantedBy: string;
  grantedAt: string;
  revokedBy?: string;
  revokedAt?: string;
}

export interface MemoryGrantRevocation {
  id: string;
  by: string;
}

export interface MemoryLogSearch {
  text: string;
  /** Matches returned per window, 1 to 50. Default: 5. A window with more is reported as `truncated`. */
  limit?: number;
  /** Width of the window: log entries read by this call, 1 to 8192. Default: 2048. */
  maxScanned?: number;
  runId?: string;
  agentId?: string;
  generation?: number;
  /** `nextCursor` of an earlier call with the same filters, to continue its scan. */
  cursor?: LogCursor;
}

export interface MemoryLogMatch {
  /** Where the entry lives in the log; use it as `provenance.logPosition`. */
  position: LogPosition;
  entry: LogEntry;
  /** The text that was matched: the entry type and the strings of its inline payload. */
  text: string;
  /** BM25 score among the matches of this call. Not comparable across calls. */
  score: number;
}

/**
 * One window of a log search: the entries read by this call, best matches first.
 *
 * A window can hold more matches than `limit`. Then `truncated` is true and
 * `found - matches.length` matches of this window were NOT returned; `nextCursor`
 * continues after the whole window and will not bring them back. To get them,
 * repeat the same call (same cursor) with a larger `limit` or a smaller
 * `maxScanned`: a window no wider than `limit` is never truncated.
 */
export interface MemoryLogSearchResult {
  matches: readonly MemoryLogMatch[];
  /** Readable matches in this window, returned or not. Withdrawn entries are not counted. */
  found: number;
  /** True when this window held more matches than it returned. */
  truncated: boolean;
  /** Log entries read by this call. */
  scanned: number;
  /** True only when the scan reached the head of the log. It says nothing about `truncated`. */
  complete: boolean;
  nextCursor?: LogCursor;
}

/**
 * `INVALID_SUPERSESSION`: a promotion named in `supersedes` an id that is not a live, promoted,
 * not yet invalidated lesson of the record's own scope. `EXPIRED`: a promotion of a record whose
 * `validUntil` has passed. Both refuse the promotion and change nothing.
 */
export type MemoryStoreErrorCode =
  | 'INVALID_INPUT' | 'DISABLED' | 'NOT_OWNER' | 'NOT_FOUND' | 'CONFLICT' | 'WITHDRAWN'
  | 'NOT_PROMOTED' | 'EMBEDDING_MISMATCH' | 'UNSUPPORTED_DATABASE' | 'STORAGE' | 'CLOSED'
  | 'INVALID_SUPERSESSION' | 'EXPIRED';

const errors = new WeakSet<object>();

/** The message carries only the code, never stored text or caller input. */
export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode;

  constructor(code: MemoryStoreErrorCode, options?: { cause?: unknown }) {
    super(`Memory store refused: ${code}`, options);
    this.name = 'MemoryStoreError';
    this.code = code;
    errors.add(this);
  }
}

export function isMemoryStoreError(value: unknown): value is MemoryStoreError {
  return !!value && typeof value === 'object' && errors.has(value);
}
