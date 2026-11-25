import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStoreError } from './store-types.js';

const APPLICATION_ID = 0x4f41524d; // OARM: dedicated HiveAgents Runtime memory database.
/**
 * The only `user_version` this module opens, and the one it keeps. Temporal validity is an
 * additive change detected by its columns (`hasTemporalColumns`), not a version bump: the
 * file is shared by every process on the machine, and a process on an older build refuses
 * any other version, so bumping it would lock that process out of its own memory.
 */
const SCHEMA_VERSION = 1;

/**
 * The views are the single definitions every read path selects from, so that a
 * withdrawal reaches all of them in one commit:
 * - `memory_withdrawn_entries`: the log entries a withdrawal covers. Revoking or
 *   rolling back a record that was taken from a log entry withdraws the entry
 *   itself, identified by source and sequence whatever digest the record claimed.
 * - `memory_readable`: "may be read" — not revoked, not rolled back, not taken
 *   from a withdrawn entry, and owned by a system whose memory is switched on.
 * - `memory_usable_grants`: live grants between two systems that both have
 *   memory switched on.
 *
 * The triggers and checks are guard rails for every connection that goes
 * through SQLite, not only for this module: a statement cannot rewrite, replace
 * or delete an episode, insert a record that is already a lesson, undo a
 * withdrawal or a grant revocation, or store a promotion whose evidence does not
 * show memory beating the no-memory control. They are not a security boundary:
 * whoever can write this file can drop them, and the database cannot tell
 * whether the evidence of a promotion was ever really measured.
 */
/**
 * Schema 1 exactly as it shipped. A new file is created with it and given the temporal
 * columns in the same transaction, so a fresh file and an extended one are the same.
 * Exported for the migration tests only; not part of any public entry.
 */
export const MEMORY_SCHEMA_V1 = `
CREATE TABLE memory_systems (
  system_id TEXT PRIMARY KEY NOT NULL CHECK(length(system_id) BETWEEN 1 AND 128),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL
) STRICT;

CREATE TABLE memory_records (
  tenant TEXT NOT NULL,
  namespace TEXT NOT NULL,
  subject TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(text) > 0),
  content_digest TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  source_id TEXT,
  source_sequence INTEGER,
  source_digest TEXT,
  input_hash TEXT,
  metadata_json TEXT,
  embedding_identity TEXT,
  embedding_json TEXT,
  recorded_at TEXT NOT NULL,
  promoted_at TEXT,
  promoted_by TEXT,
  gate_json TEXT,
  rolled_back_at TEXT,
  rolled_back_by TEXT,
  rollback_reason TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  PRIMARY KEY (tenant, namespace, subject, id),
  CHECK(source_id IS NOT NULL OR input_hash IS NOT NULL),
  CHECK((source_id IS NULL) = (source_sequence IS NULL) AND (source_id IS NULL) = (source_digest IS NULL)),
  CHECK((promoted_at IS NULL) = (gate_json IS NULL) AND (promoted_at IS NULL) = (promoted_by IS NULL)),
  CHECK(promoted_at IS NULL
    OR (json_extract(gate_json, '$.memory.passed') > json_extract(gate_json, '$.noMemory.passed')) IS TRUE)
) STRICT;
CREATE INDEX memory_records_source ON memory_records(tenant, source_id, source_sequence);

CREATE TABLE memory_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  grantee TEXT NOT NULL CHECK(grantee <> owner),
  namespace TEXT NOT NULL,
  subject TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT
) STRICT;
CREATE INDEX memory_grants_scope ON memory_grants(owner, grantee, namespace, subject);

CREATE VIEW memory_withdrawn_entries AS
SELECT tenant, source_id, source_sequence FROM memory_records
WHERE source_id IS NOT NULL AND (revoked_at IS NOT NULL OR rolled_back_at IS NOT NULL);

CREATE VIEW memory_readable AS
SELECT r.* FROM memory_records r
JOIN memory_systems s ON s.system_id = r.tenant AND s.enabled = 1
WHERE r.revoked_at IS NULL AND r.rolled_back_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_withdrawn_entries w
    WHERE w.tenant = r.tenant AND w.source_id = r.source_id AND w.source_sequence = r.source_sequence);

CREATE VIEW memory_usable_grants AS
SELECT g.* FROM memory_grants g
JOIN memory_systems o ON o.system_id = g.owner AND o.enabled = 1
JOIN memory_systems t ON t.system_id = g.grantee AND t.enabled = 1
WHERE g.revoked_at IS NULL;

CREATE TRIGGER memory_records_born_episode BEFORE INSERT ON memory_records BEGIN
  SELECT RAISE(ABORT, 'memory episodes are immutable') WHERE EXISTS (
    SELECT 1 FROM memory_records
    WHERE tenant = NEW.tenant AND namespace = NEW.namespace AND subject = NEW.subject AND id = NEW.id);
  SELECT RAISE(ABORT, 'a memory record starts as an episode')
  WHERE NEW.promoted_at IS NOT NULL OR NEW.promoted_by IS NOT NULL OR NEW.gate_json IS NOT NULL
    OR NEW.rolled_back_at IS NOT NULL OR NEW.rolled_back_by IS NOT NULL OR NEW.rollback_reason IS NOT NULL
    OR NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL;
END;

CREATE TRIGGER memory_records_immutable BEFORE UPDATE OF
  tenant, namespace, subject, id, text, content_digest, provenance_json, source_id, source_sequence,
  source_digest, input_hash, metadata_json, embedding_identity, embedding_json, recorded_at
ON memory_records BEGIN
  SELECT RAISE(ABORT, 'memory episodes are immutable');
END;
CREATE TRIGGER memory_records_kept BEFORE DELETE ON memory_records BEGIN
  SELECT RAISE(ABORT, 'memory episodes are immutable');
END;
CREATE TRIGGER memory_records_withdrawal_final BEFORE UPDATE OF
  revoked_at, revoked_reason, rolled_back_at, rolled_back_by, rollback_reason
ON memory_records WHEN OLD.revoked_at IS NOT NULL OR OLD.rolled_back_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'a memory withdrawal is final');
END;
CREATE TRIGGER memory_records_promotion_final BEFORE UPDATE OF promoted_at, promoted_by, gate_json
ON memory_records WHEN OLD.promoted_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'a memory promotion is final');
END;

CREATE TRIGGER memory_grants_born_live BEFORE INSERT ON memory_grants BEGIN
  SELECT RAISE(ABORT, 'memory grants are immutable') WHERE EXISTS (
    SELECT 1 FROM memory_grants WHERE grant_id = NEW.grant_id);
  SELECT RAISE(ABORT, 'a memory grant starts live') WHERE NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL;
END;
CREATE TRIGGER memory_grants_immutable BEFORE UPDATE OF
  grant_id, owner, grantee, namespace, subject, granted_by, granted_at
ON memory_grants BEGIN
  SELECT RAISE(ABORT, 'memory grants are immutable');
END;
CREATE TRIGGER memory_grants_kept BEFORE DELETE ON memory_grants BEGIN
  SELECT RAISE(ABORT, 'memory grants are immutable');
END;
CREATE TRIGGER memory_grants_revocation_final BEFORE UPDATE OF revoked_at, revoked_by
ON memory_grants WHEN OLD.revoked_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'a grant revocation is final');
END;

PRAGMA application_id = ${APPLICATION_ID};
PRAGMA user_version = 1;
`;

/**
 * Additive migration: temporal validity. Adds the record's `supersedes` (JSON array of ids of
 * its own scope) and `validUntil` (UTC) as content, and the final invalidation of a lesson that
 * a promoted record superseded. Every existing row keeps its values and gets NULL in the new
 * columns, which means "supersedes nothing, valid forever, not invalidated". The file stays at
 * `user_version` 1 (see `SCHEMA_VERSION`).
 *
 * The guard rails are extended, never relaxed: the new content columns join the immutable
 * set; a record still starts as an episode, now also never invalidated; an invalidation is
 * final; and it is accepted only on a live promoted lesson, naming a promoted record of the
 * same scope whose `supersedes` lists it. `memory_readable` is recreated unchanged so that its
 * `r.*` carries the new columns.
 *
 * Every statement an older build runs keeps working on the extended file: it names its
 * columns on insert (the new ones default to NULL, which the triggers accept), and its
 * promotion, revocation, rollback and grant updates touch none of the new columns. What an
 * older build does not do is honour them: a process on that build still recalls a lesson a
 * newer build invalidated or that has expired, and promoting a record there does not retire
 * what it supersedes. That is a stale fact, not an injection path: only promoted lessons are
 * recalled either way, and nothing the older build reads was written without the gate.
 */
const TEMPORAL_COLUMNS = `
ALTER TABLE memory_records ADD COLUMN supersedes_json TEXT
  CHECK(supersedes_json IS NULL OR (json_valid(supersedes_json) AND json_type(supersedes_json) = 'array'));
ALTER TABLE memory_records ADD COLUMN valid_until TEXT;
ALTER TABLE memory_records ADD COLUMN invalidated_at TEXT;
ALTER TABLE memory_records ADD COLUMN invalidated_by TEXT;

DROP VIEW memory_readable;
CREATE VIEW memory_readable AS
SELECT r.* FROM memory_records r
JOIN memory_systems s ON s.system_id = r.tenant AND s.enabled = 1
WHERE r.revoked_at IS NULL AND r.rolled_back_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_withdrawn_entries w
    WHERE w.tenant = r.tenant AND w.source_id = r.source_id AND w.source_sequence = r.source_sequence);

DROP TRIGGER memory_records_born_episode;
CREATE TRIGGER memory_records_born_episode BEFORE INSERT ON memory_records BEGIN
  SELECT RAISE(ABORT, 'memory episodes are immutable') WHERE EXISTS (
    SELECT 1 FROM memory_records
    WHERE tenant = NEW.tenant AND namespace = NEW.namespace AND subject = NEW.subject AND id = NEW.id);
  SELECT RAISE(ABORT, 'a memory record starts as an episode')
  WHERE NEW.promoted_at IS NOT NULL OR NEW.promoted_by IS NOT NULL OR NEW.gate_json IS NOT NULL
    OR NEW.rolled_back_at IS NOT NULL OR NEW.rolled_back_by IS NOT NULL OR NEW.rollback_reason IS NOT NULL
    OR NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL
    OR NEW.invalidated_at IS NOT NULL OR NEW.invalidated_by IS NOT NULL;
END;

DROP TRIGGER memory_records_immutable;
CREATE TRIGGER memory_records_immutable BEFORE UPDATE OF
  tenant, namespace, subject, id, text, content_digest, provenance_json, source_id, source_sequence,
  source_digest, input_hash, metadata_json, embedding_identity, embedding_json, recorded_at,
  supersedes_json, valid_until
ON memory_records BEGIN
  SELECT RAISE(ABORT, 'memory episodes are immutable');
END;

CREATE TRIGGER memory_records_invalidation_final BEFORE UPDATE OF invalidated_at, invalidated_by
ON memory_records WHEN OLD.invalidated_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'a memory invalidation is final');
END;
CREATE TRIGGER memory_records_invalidation_checked BEFORE UPDATE OF invalidated_at, invalidated_by
ON memory_records WHEN OLD.invalidated_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'a memory invalidation needs a promoted record of the scope that supersedes this lesson')
  WHERE NEW.invalidated_at IS NULL OR NEW.invalidated_by IS NULL
    OR OLD.promoted_at IS NULL OR OLD.revoked_at IS NOT NULL OR OLD.rolled_back_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM memory_records s, json_each(s.supersedes_json) j
      WHERE s.tenant = OLD.tenant AND s.namespace = OLD.namespace AND s.subject = OLD.subject
        AND s.id = NEW.invalidated_by AND s.promoted_at IS NOT NULL AND j.value = OLD.id);
END;
`;

const TEMPORAL_COLUMN_NAMES = ['supersedes_json', 'valid_until', 'invalidated_at', 'invalidated_by'];

function userVersion(db: DatabaseSync): unknown {
  return db.prepare('PRAGMA user_version').get()?.user_version;
}

/**
 * Whether `memory_records` carries the temporal columns. All four or none: the migration adds
 * them in one transaction, so a file with only some of them was changed by something else and
 * is refused.
 */
function hasTemporalColumns(db: DatabaseSync): boolean {
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('memory_records')").all().map(row => String(row.name)));
  const present = TEMPORAL_COLUMN_NAMES.filter(name => columns.has(name)).length;
  if (present !== 0 && present !== TEMPORAL_COLUMN_NAMES.length) throw new MemoryStoreError('UNSUPPORTED_DATABASE');
  return present !== 0;
}

/**
 * Adds the temporal columns to a file that lacks them, once: the check is repeated inside an
 * immediate transaction, so of two openers racing on the same file one migrates and the other
 * finds it done. A failed migration rolls back and leaves the file as it was.
 */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasTemporalColumns(db)) db.exec(TEMPORAL_COLUMNS);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Publishes a complete database atomically. An existing file is never touched:
 * a losing first-open contender adopts the winner's file, and an empty or
 * foreign file is refused later instead of being initialised over.
 */
function publish(path: string): void {
  if (exists(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.initializing`;
  closeSync(openSync(temporary, 'wx', 0o600));
  let candidate: DatabaseSync | undefined;
  try {
    candidate = new DatabaseSync(temporary);
    candidate.exec(`PRAGMA synchronous = FULL; BEGIN IMMEDIATE; ${MEMORY_SCHEMA_V1} ${TEMPORAL_COLUMNS} COMMIT;`);
    candidate.close();
    candidate = undefined;
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    candidate?.close();
    unlinkSync(temporary);
  }
}

/**
 * Opens the memory database, creating it when absent and adding the temporal columns once to
 * a file that lacks them. Refuses any file this module did not create, and any `user_version`
 * other than 1.
 */
export function openMemoryDatabase(path: string, busyTimeoutMs: number): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    publish(path);
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;`);
    const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;
    if (applicationId !== APPLICATION_ID || userVersion(db) !== SCHEMA_VERSION) throw new MemoryStoreError('UNSUPPORTED_DATABASE');
    if (!hasTemporalColumns(db)) migrate(db);
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof MemoryStoreError) throw error;
    throw new MemoryStoreError('STORAGE', { cause: error });
  }
}
