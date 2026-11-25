import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonical, freeze } from '../../shared/json.js';
import { evaluateMemoryGate } from './gate.js';
import { rankLogCandidates, scanRunLog } from './log-search.js';
import type { RunLogReader } from './log-search.js';
import type {
  MemoryPersistencePort, MemoryQuery, MemoryQueryPort, MemoryRecordLookup, MemoryRevocation, ScopedMemoryRecord,
} from './ports.js';
import { rankMemories } from './ranker.js';
import { INSERT_RECORD, contentDigest, insertValues, toGrant, toRecord, toView } from './records.js';
import type { GrantRow, RecordRow } from './records.js';
import { openMemoryDatabase } from './schema.js';
import { invalidateLessons, supersededLessons } from './supersession.js';
import { MemoryStoreError, isMemoryStoreError } from './store-types.js';
import type {
  MemoryActor, MemoryGrant, MemoryGrantRequest, MemoryGrantRevocation, MemoryListQuery, MemoryLogSearch,
  MemoryLogSearchResult, MemoryPromotion, MemoryPromotionResult, MemoryRecordView, MemoryRollback,
  MemoryStatus, SystemMemoryOptions,
} from './store-types.js';
import {
  captureActor, captureGrant, captureGrantRevocation, captureList, captureLogSearch, captureLookup, captureOptions,
  capturePromotion, captureQuery, captureRecord, captureRevocation, captureRollback, captureSignal, storedInstant, timestamp,
  utc,
} from './validation.js';
import type { CapturedScope } from './validation.js';

/** Lessons considered by one recall before ranking: the most recently promoted ones. */
const RECALL_POOL = 512;

/**
 * Orders stored timestamps by instant. This build stores every timestamp in UTC (`toISOString()`
 * form), but a file can also hold strings with a UTC offset, written before this build or by an
 * older build on the same machine, and those do not sort as instants. The function is registered
 * on this module's own connections and used only in its queries, never in the schema (views,
 * triggers, indexes): the file must stay openable, unchanged, by every build.
 */
const UTC = 'oar_memory_utc';

/**
 * Recall, for the owner or through a grant, in one statement: the record must be
 * readable, promoted, not invalidated, not expired at the query time (UTC), in the exact scope,
 * the reader's own memory must be on, and the reader must be the owner or hold a
 * live grant for that exact scope.
 */
const RECALL = `
SELECT r.* FROM memory_readable r
WHERE r.tenant = $tenant AND r.namespace = $namespace AND r.subject = $subject
  AND r.promoted_at IS NOT NULL AND r.invalidated_at IS NULL
  AND (r.valid_until IS NULL OR r.valid_until >= $now)
  AND EXISTS (SELECT 1 FROM memory_systems s WHERE s.system_id = $reader AND s.enabled = 1)
  AND (r.tenant = $reader OR EXISTS (
    SELECT 1 FROM memory_usable_grants g
    WHERE g.owner = r.tenant AND g.grantee = $reader AND g.namespace = r.namespace AND g.subject = r.subject))
ORDER BY ${UTC}(r.promoted_at) DESC, r.id
LIMIT ${RECALL_POOL}`;

const FIND = 'SELECT * FROM memory_records WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?';
const FIND_READABLE = 'SELECT * FROM memory_readable WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?';

const ENTRY_WITHDRAWN = `
SELECT 1 FROM memory_withdrawn_entries WHERE tenant = ? AND source_id = ? AND source_sequence = ? LIMIT 1`;

const EMPTY_SEARCH: MemoryLogSearchResult = freeze({ matches: [], found: 0, truncated: false, scanned: 0, complete: false });

/**
 * One system's handle on the shared memory database.
 *
 * What a caller can rely on:
 * - Memory is off until `enable`: reads of memory are empty and writes are
 *   refused. The two administrative reads that stay are `status` and the grants
 *   the system itself gave (`listGrants`).
 * - A record lives in an exact scope (tenant = system id, namespace, subject) and
 *   always carries provenance pointing at its source.
 * - Reads are deny-by-default: another system gets nothing unless the owner
 *   granted that exact scope, and a grant shares recall (`query`) only.
 * - An observation is an immutable episode. Only `promote`, with a gate that
 *   passed, makes it a lesson that `query` returns; at most a few per recall.
 * - `revoke` and `rollback` are final and take effect on every read at once,
 *   for every connection: there is no cache between a read and the database.
 * - A record's `supersedes` takes effect only when the record is promoted: then
 *   every lesson it names is invalidated in the same transaction, for good, and
 *   `query` never returns it again. A record past its `validUntil` is never
 *   returned by `query` and cannot be promoted.
 * - A withdrawal covers the source, not only the record id. When the withdrawn
 *   record was taken from a log entry, that entry is withdrawn as a whole:
 *   `searchLog` stops returning it, every other record taken from it stops being
 *   returned by `query` and `list`, and nothing taken from it can be stored or
 *   promoted again.
 */
export class SqliteSystemMemory implements MemoryPersistencePort, MemoryQueryPort {
  readonly systemId: string;
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #maxLessons: number;
  #closed = false;

  constructor(options: SystemMemoryOptions) {
    const config = captureOptions(options);
    this.systemId = config.systemId;
    // Stored in UTC whatever offset the clock gives, so that stored timestamps order as instants.
    this.#now = () => utc(timestamp(config.now()));
    this.#maxLessons = config.maxLessonsPerRecall;
    this.#db = openMemoryDatabase(config.databasePath, config.busyTimeoutMs);
    this.#db.function(UTC, { deterministic: true }, (value: unknown) => (typeof value === 'string' ? storedInstant(value) : null));
  }

  #open(): DatabaseSync {
    if (this.#closed) throw new MemoryStoreError('CLOSED');
    return this.#db;
  }

  /** Runs `body` in one transaction. Reads use it too when they need two consistent statements. */
  #transaction<T>(body: (db: DatabaseSync) => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
    const db = this.#open();
    try {
      db.exec(`BEGIN ${mode}`);
      try {
        const result = body(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (isMemoryStoreError(error)) throw error;
      throw new MemoryStoreError('STORAGE', { cause: error });
    }
  }

  #read<T>(body: (db: DatabaseSync) => T): T {
    const db = this.#open();
    try {
      return body(db);
    } catch (error) {
      if (isMemoryStoreError(error)) throw error;
      throw new MemoryStoreError('STORAGE', { cause: error });
    }
  }

  #enabled(db: DatabaseSync, systemId = this.systemId): boolean {
    return db.prepare('SELECT 1 FROM memory_systems WHERE system_id = ? AND enabled = 1').get(systemId) !== undefined;
  }

  /** Writes belong to the owner alone; a grant never extends to them. */
  #assertOwner(scope: CapturedScope): void {
    if (scope.tenant !== this.systemId) throw new MemoryStoreError('NOT_OWNER');
  }

  #find(db: DatabaseSync, scope: CapturedScope, id: string): RecordRow {
    const row = db.prepare(FIND).get(scope.tenant, scope.namespace, scope.subject, id) as RecordRow | undefined;
    if (!row) throw new MemoryStoreError('NOT_FOUND');
    return row;
  }

  /** True when a withdrawal covers this log entry: some record taken from it was revoked or rolled back. */
  #entryWithdrawn(db: DatabaseSync, sourceId: string, sequence: number): boolean {
    return db.prepare(ENTRY_WITHDRAWN).get(this.systemId, sourceId, sequence) !== undefined;
  }

  /** Withdrawn by its own tombstone, or because the log entry it was taken from is withdrawn. */
  #withdrawn(db: DatabaseSync, row: RecordRow): boolean {
    if (row.revoked_at !== null || row.rolled_back_at !== null) return true;
    return row.source_id !== null && row.source_sequence !== null
      && this.#entryWithdrawn(db, row.source_id, row.source_sequence);
  }

  #setEnabled(actor: MemoryActor, enabled: boolean): void {
    const by = captureActor(actor);
    this.#transaction(db => {
      db.prepare(`
        INSERT INTO memory_systems (system_id, enabled, changed_by, changed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(system_id) DO UPDATE SET
          enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at
      `).run(this.systemId, enabled ? 1 : 0, by, this.#now());
    });
  }

  /** Switches this system's memory on. Recorded with who did it and when. */
  async enable(actor: MemoryActor): Promise<void> {
    this.#setEnabled(actor, true);
  }

  /** Switches it off: every read of this system's memory, by anyone, is empty at once. Nothing is deleted. */
  async disable(actor: MemoryActor): Promise<void> {
    this.#setEnabled(actor, false);
  }

  async status(): Promise<MemoryStatus> {
    const row = this.#read(db => db.prepare(
      'SELECT enabled, changed_by, changed_at FROM memory_systems WHERE system_id = ?',
    ).get(this.systemId));
    if (!row) return { systemId: this.systemId, enabled: false };
    return {
      systemId: this.systemId,
      enabled: row.enabled === 1,
      changedBy: String(row.changed_by),
      changedAt: storedInstant(String(row.changed_at)),
    };
  }

  /**
   * Stores an observation as an immutable episode in the owner's exact scope.
   * Storing the same content again is a no-op; different content under the same
   * id is CONFLICT; a withdrawn id, or a log entry whose record was withdrawn,
   * is WITHDRAWN and cannot come back.
   *
   * Provenance is checked for shape, not against its source: this call has no
   * handle on the log, so it cannot tell that the entry exists or says what the
   * text says. A withdrawal can reach the log entry only if the record names it:
   * store what came from `searchLog` with that match's position as `logPosition`.
   */
  async put(record: ScopedMemoryRecord, signal?: AbortSignal): Promise<void> {
    const input = captureRecord(record);
    captureSignal(signal)?.throwIfAborted();
    this.#assertOwner(input.scope);
    this.#transaction(db => {
      if (!this.#enabled(db)) throw new MemoryStoreError('DISABLED');
      const { tenant, namespace, subject } = input.scope;
      const existing = db.prepare(FIND).get(tenant, namespace, subject, input.id) as RecordRow | undefined;
      if (existing) {
        if (this.#withdrawn(db, existing)) throw new MemoryStoreError('WITHDRAWN');
        if (existing.content_digest !== contentDigest(input)) throw new MemoryStoreError('CONFLICT');
        return;
      }
      const position = input.provenance.logPosition;
      if (position && this.#entryWithdrawn(db, position.sourceId, position.sequence)) {
        throw new MemoryStoreError('WITHDRAWN');
      }
      if (input.embedding) {
        // Only readable records count: a scope can move to a new model once the old vectors are withdrawn.
        const other = db.prepare(`
          SELECT 1 FROM memory_readable
          WHERE tenant = ? AND namespace = ? AND subject = ?
            AND embedding_identity IS NOT NULL AND embedding_identity <> ? LIMIT 1
        `).get(tenant, namespace, subject, input.embedding.identityKey);
        if (other) throw new MemoryStoreError('EMBEDDING_MISMATCH');
      }
      db.prepare(INSERT_RECORD).run(...insertValues(input, this.#now()));
    });
  }

  /**
   * The owner's read-back of one record, episode or lesson, as stored: undefined when there is
   * none, it is withdrawn, memory is off, or the scope is another system's (grant or not). For a
   * writer that met CONFLICT on `put`; recall is `query`.
   */
  async get(lookup: MemoryRecordLookup): Promise<ScopedMemoryRecord | undefined> {
    const input = captureLookup(lookup);
    input.signal?.throwIfAborted();
    const { tenant, namespace, subject } = input.scope;
    if (tenant !== this.systemId) {
      this.#open();
      return undefined;
    }
    const row = this.#read(db => db.prepare(FIND_READABLE).get(tenant, namespace, subject, input.id)) as RecordRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /**
   * Withdraws a record for good. Allowed while memory is off: forgetting never
   * requires switching memory on. Revoking again keeps the first tombstone.
   */
  async revoke(revocation: MemoryRevocation, signal?: AbortSignal): Promise<void> {
    const input = captureRevocation(revocation);
    captureSignal(signal)?.throwIfAborted();
    this.#assertOwner(input.scope);
    this.#transaction(db => {
      const row = this.#find(db, input.scope, input.id);
      if (row.revoked_at !== null || row.rolled_back_at !== null) return;
      db.prepare(`
        UPDATE memory_records SET revoked_at = ?, revoked_reason = ?
        WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?
      `).run(input.revokedAt, input.reason, row.tenant, row.namespace, row.subject, row.id);
    });
  }

  /**
   * Recall: the promoted lessons of one exact scope, ranked against the text.
   * Own scope, or another system's scope through a live grant; anything else is
   * empty. Never more than `maxLessonsPerRecall`, whatever `limit` asks for.
   */
  async query(query: MemoryQuery): Promise<readonly ScopedMemoryRecord[]> {
    const input = captureQuery(query);
    input.signal?.throwIfAborted();
    const { tenant, namespace, subject } = input.scope;
    const now = this.#now();
    const rows = this.#read(db => db.prepare(RECALL).all({
      $tenant: tenant, $namespace: namespace, $subject: subject, $reader: this.systemId, $now: now,
    })) as unknown as RecordRow[];
    const limit = Math.min(input.limit, this.#maxLessons);
    if (rows.length === 0 || limit === 0) return [];
    if (!input.embedding) {
      const documents = rows.map(row => ({ id: row.id, text: row.text, row }));
      return rankMemories(input.text, documents, { limit }).map(({ record }) => toRecord(record.row));
    }
    const asked = input.embedding;
    const documents = rows.map(row => {
      if (row.embedding_identity === null || row.embedding_json === null) return { id: row.id, text: row.text, row };
      // Vectors of another model or revision are never compared: the recall is refused instead.
      if (row.embedding_identity !== asked.identityKey) throw new MemoryStoreError('EMBEDDING_MISMATCH');
      return { id: row.id, text: row.text, row, embedding: JSON.parse(row.embedding_json) as number[] };
    });
    const options = { limit, lexicalWeight: 0.5, semanticWeight: 0.5, queryEmbedding: asked.values };
    return rankMemories(input.text, documents, options).map(({ record }) => toRecord(record.row));
  }

  /**
   * The owner's view of one exact scope: episodes, lessons, invalidated and expired
   * records, newest first, with the promotion evidence of each lesson and the
   * invalidation of each superseded one. Withdrawn records are not listed. Other
   * systems get nothing, grant or not.
   */
  async list(query: MemoryListQuery): Promise<readonly MemoryRecordView[]> {
    const input = captureList(query);
    if (input.scope.tenant !== this.systemId) {
      this.#open();
      return [];
    }
    const rows = this.#read(db => db.prepare(`
      SELECT * FROM memory_readable WHERE tenant = ? AND namespace = ? AND subject = ?
      ORDER BY ${UTC}(recorded_at) DESC, id LIMIT ?
    `).all(input.scope.tenant, input.scope.namespace, input.scope.subject, input.limit)) as unknown as RecordRow[];
    const now = this.#now();
    return rows.map(row => toView(row, now));
  }

  /**
   * Makes an episode recallable, if and only if the gate passed: the evidence must
   * hold both controls, must have measured this record (it names the record's
   * content digest, which binds scope, id and content), and memory must beat the
   * no-memory control. A refusal is a normal result and changes nothing.
   *
   * A record past its `validUntil` is EXPIRED. A record that supersedes others
   * retires them here, in this transaction, at the promotion time; when any of
   * them is not a live lesson of this scope the promotion is INVALID_SUPERSESSION
   * and nothing changes. A retried promotion returns the first one.
   */
  async promote(promotion: MemoryPromotion): Promise<MemoryPromotionResult> {
    const input = capturePromotion(promotion);
    this.#assertOwner(input.scope);
    return this.#transaction((db): MemoryPromotionResult => {
      if (!this.#enabled(db)) throw new MemoryStoreError('DISABLED');
      const row = this.#find(db, input.scope, input.id);
      if (this.#withdrawn(db, row)) throw new MemoryStoreError('WITHDRAWN');
      if (row.promoted_at !== null) return { promoted: true, promotedAt: storedInstant(row.promoted_at) };
      if (!input.gate.candidateDigests.includes(row.content_digest)) return { promoted: false, reason: 'CANDIDATE_NOT_MEASURED' };
      const verdict = evaluateMemoryGate(input.gate);
      if (!verdict.passed) return { promoted: false, reason: verdict.reason };
      const promotedAt = this.#now();
      if (row.valid_until !== null && row.valid_until < promotedAt) throw new MemoryStoreError('EXPIRED');
      const superseded = supersededLessons(db, row, target => this.#withdrawn(db, target));
      db.prepare(`
        UPDATE memory_records SET promoted_at = ?, promoted_by = ?, gate_json = ?
        WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?
      `).run(promotedAt, input.by, canonical(input.gate), row.tenant, row.namespace, row.subject, row.id);
      invalidateLessons(db, superseded, row.id, promotedAt);
      return { promoted: true, promotedAt };
    });
  }

  /**
   * Reverses a promotion after a measured regression. Final, like a revocation:
   * no read path returns the lesson again and it cannot be promoted again.
   * Allowed while memory is off.
   */
  async rollback(rollback: MemoryRollback): Promise<void> {
    const input = captureRollback(rollback);
    this.#assertOwner(input.scope);
    this.#transaction(db => {
      const row = this.#find(db, input.scope, input.id);
      if (row.revoked_at !== null || row.rolled_back_at !== null) return;
      if (row.promoted_at === null) throw new MemoryStoreError('NOT_PROMOTED');
      db.prepare(`
        UPDATE memory_records SET rolled_back_at = ?, rolled_back_by = ?, rollback_reason = ?
        WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?
      `).run(this.#now(), input.by, input.reason, row.tenant, row.namespace, row.subject, row.id);
    });
  }

  /**
   * Lets another system recall this system's lessons in one exact scope. Recorded
   * with who granted it and when. Granting a scope that is already granted returns
   * the live grant.
   */
  async grant(request: MemoryGrantRequest): Promise<MemoryGrant> {
    const input = captureGrant(request);
    if (input.to === this.systemId) throw new MemoryStoreError('INVALID_INPUT');
    return this.#transaction(db => {
      if (!this.#enabled(db)) throw new MemoryStoreError('DISABLED');
      const live = db.prepare(`
        SELECT * FROM memory_grants
        WHERE owner = ? AND grantee = ? AND namespace = ? AND subject = ? AND revoked_at IS NULL
      `).get(this.systemId, input.to, input.namespace, input.subject) as GrantRow | undefined;
      if (live) return toGrant(live);
      const row: GrantRow = {
        grant_id: randomUUID(),
        owner: this.systemId,
        grantee: input.to,
        namespace: input.namespace,
        subject: input.subject,
        granted_by: input.by,
        granted_at: this.#now(),
        revoked_by: null,
        revoked_at: null,
      };
      db.prepare(`
        INSERT INTO memory_grants (grant_id, owner, grantee, namespace, subject, granted_by, granted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.grant_id, row.owner, row.grantee, row.namespace, row.subject, row.granted_by, row.granted_at);
      return toGrant(row);
    });
  }

  /** Ends a grant this system gave. The grantee's next read is empty. Final; grant again to share again. */
  async revokeGrant(revocation: MemoryGrantRevocation): Promise<void> {
    const input = captureGrantRevocation(revocation);
    this.#transaction(db => {
      const row = db.prepare('SELECT revoked_at FROM memory_grants WHERE grant_id = ? AND owner = ?')
        .get(input.id, this.systemId);
      if (!row) throw new MemoryStoreError('NOT_FOUND');
      if (row.revoked_at !== null) return;
      db.prepare('UPDATE memory_grants SET revoked_at = ?, revoked_by = ? WHERE grant_id = ?')
        .run(this.#now(), input.by, input.id);
    });
  }

  /**
   * Grant metadata: no memory text, but namespace and subject are names the owner chose.
   * - Every grant this system gave, live or revoked, whether its memory is on or
   *   off: its own administrative record, needed to revoke a grant while off.
   * - The grants it received that it can use right now: live, and with both
   *   systems' memory on. A revoked grant, or either switch off, hides them.
   */
  async listGrants(): Promise<readonly MemoryGrant[]> {
    const rows = this.#read(db => db.prepare(`
      SELECT * FROM (
        SELECT * FROM memory_grants WHERE owner = $reader
        UNION ALL
        SELECT * FROM memory_usable_grants WHERE grantee = $reader)
      ORDER BY ${UTC}(granted_at), grant_id
    `).all({ $reader: this.systemId })) as unknown as GrantRow[];
    return rows.map(toGrant);
  }

  /**
   * Plain-text search over this system's own run log, the first form of recall.
   * Each match carries its log position, ready to be a record's provenance.
   * Empty while memory is off, for a log of another system, and for any entry
   * whose memory record was revoked or rolled back.
   *
   * One call reads one window of the log (`maxScanned` entries) and returns its
   * best `limit` matches. When the window held more, the result says so
   * (`truncated`, `found`): see `MemoryLogSearchResult` for how to get the rest.
   */
  async searchLog(log: RunLogReader, search: MemoryLogSearch): Promise<MemoryLogSearchResult> {
    const input = captureLogSearch(search);
    const descriptor = (log as Partial<RunLogReader> | null | undefined)?.descriptor;
    if (typeof log?.readPage !== 'function' || typeof descriptor?.systemId !== 'string' || typeof descriptor.sourceId !== 'string') {
      throw new MemoryStoreError('INVALID_INPUT');
    }
    if (descriptor.systemId !== this.systemId || !this.#read(db => this.#enabled(db))) return EMPTY_SEARCH;
    if (!input.text.trim()) return EMPTY_SEARCH;
    const scan = await scanRunLog(log, this.systemId, input);
    // Read withdrawals after the scan, so one that landed meanwhile is honoured.
    const withdrawn = this.#transaction(db => {
      if (!this.#enabled(db)) return undefined;
      const rows = db.prepare('SELECT source_sequence FROM memory_withdrawn_entries WHERE tenant = ? AND source_id = ?')
        .all(this.systemId, descriptor.sourceId);
      return new Set(rows.map(row => Number(row.source_sequence)));
    }, 'DEFERRED');
    if (!withdrawn) return EMPTY_SEARCH;
    const readable = scan.candidates.filter(({ position }) => !withdrawn.has(position.sequence));
    const matches = rankLogCandidates(input.text, readable, input.limit);
    return freeze({
      matches,
      found: readable.length,
      truncated: readable.length > matches.length,
      scanned: scan.scanned,
      complete: scan.complete,
      ...(scan.nextCursor ? { nextCursor: scan.nextCursor } : {}),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
