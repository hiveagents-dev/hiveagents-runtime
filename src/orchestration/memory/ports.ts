import type { LogPosition } from '../log/types.js';
import type { JsonValue } from '../workflow/types.js';

/** Scope and persistence belong to the application; no global store or implicit cross-scope recall. */
export interface MemoryScope { tenant: string; namespace: string; subject?: string }
export interface MemoryProvenance {
  source: string;
  sourceVersion: string;
  observedAt: string;
  inputHash?: string;
  /** The run-log entry this record was taken from, when it came from a system's own log. */
  logPosition?: LogPosition;
}
/** Vectors from another identity must never be compared as if they shared a space. */
export interface EmbeddingIdentity { provider: string; model: string; revision: string; dimensions: number }
/**
 * Temporal validity: a newer fact retires an older one instead of both being recalled.
 *
 * - `supersedes` names lessons of the SAME scope that this record replaces (ids only: a record
 *   never reaches into another scope). It takes effect when this record is PROMOTED, never when
 *   it is put: an unpromoted episode cannot retire anything, so an injected episode cannot
 *   suppress good memory. On promotion every superseded lesson is marked invalidated by this
 *   record's id at the promotion time, in the same commit. That is a final, auditable state like
 *   a rollback, not a deletion: the lesson stays listed, is never recalled again, and rolling back
 *   the newer record does not restore it. A store refuses the promotion, with a typed error and
 *   changing nothing, when any named id is not a live, promoted, not yet invalidated lesson of
 *   this scope (unknown, an episode, withdrawn, already invalidated, or only present in another
 *   scope).
 * - `validUntil` is a strict ISO-8601 instant (`YYYY-MM-DDTHH:MM[:SS[.fraction]]` then `Z` or
 *   `±HH:MM`) after which the record must not be recalled. Stores keep it in UTC as
 *   `Date.prototype.toISOString()` gives it. An expired record cannot be promoted.
 *
 * Both are part of the record's content: they count in its content digest when present.
 */
export interface ScopedMemoryRecord {
  id: string;
  scope: MemoryScope;
  text: string;
  provenance: MemoryProvenance;
  metadata?: JsonValue;
  embedding?: { identity: EmbeddingIdentity; values: readonly number[] };
  revokedAt?: string;
  /** Ids of lessons in the same scope this record replaces once it is promoted. Nonempty, no repeats. */
  supersedes?: readonly string[];
  /** Strict ISO-8601 instant after which the record is never recalled. */
  validUntil?: string;
}
export interface MemoryQuery {
  scope: MemoryScope;
  text: string;
  limit: number;
  /** A store must reject mismatched embedding spaces rather than silently comparing them. */
  embedding?: { identity: EmbeddingIdentity; values: readonly number[] };
  signal?: AbortSignal;
}
export interface MemoryRevocation { scope: MemoryScope; id: string; revokedAt: string; reason: string }
export interface MemoryRecordLookup { scope: MemoryScope; id: string; signal?: AbortSignal }
export interface MemoryPersistencePort {
  /** Must retain scope/provenance and reject embedding identity/dimension mismatches. */
  put(record: ScopedMemoryRecord, signal?: AbortSignal): Promise<void>;
  /** Atomic tombstone; implementations must exclude revoked records from query results. */
  revoke(revocation: MemoryRevocation, signal?: AbortSignal): Promise<void>;
  /**
   * Optional read-back for a writer, never recall: the record stored under this id in this exact
   * scope, episode or lesson, as stored; undefined when there is none, it is withdrawn, or the
   * caller may not read that scope. `memoryProviderFromPorts` uses it to tell a proposal made
   * again (same text, a CONFLICT on `put`) from another record under the same id; without it,
   * that CONFLICT is passed on.
   */
  get?(lookup: MemoryRecordLookup): Promise<ScopedMemoryRecord | undefined>;
}
export interface MemoryQueryPort {
  /**
   * Exact scope only; excludes revoked, invalidated (superseded) and expired (`validUntil` passed)
   * records. Ranking policy remains application-owned.
   */
  query(query: MemoryQuery): Promise<readonly ScopedMemoryRecord[]>;
}
export interface MemoryPorts { persistence?: MemoryPersistencePort; recall?: MemoryQueryPort }
/**
 * The application's embedding model, behind one call. The SDK ships none and
 * downloads none: an embedder is always supplied by the caller.
 *
 * `embed` returns one vector per text, in the same order. Every vector must
 * have exactly `identity.dimensions` entries, all finite numbers; a consumer
 * rejects anything else instead of padding or truncating it. `identity` names
 * the vector space: records and queries embedded under another identity are
 * never compared with these. It must not change for the lifetime of the
 * embedder; a new model or revision is a new embedder.
 */
export interface MemoryEmbedder {
  readonly identity: EmbeddingIdentity;
  /** Must observe `signal`; an aborted call rejects. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>>;
}
