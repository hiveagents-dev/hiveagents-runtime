import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** "OARI": the file is an HiveAgents Runtime decision inbox and nothing else. */
export const INBOX_APPLICATION_ID = 0x4f415249;
export const INBOX_USER_VERSION = 1;

const SAFE_INTEGER = '9007199254740991';

/**
 * The triggers keep any writer of the file from breaking the record by mistake, not only this
 * code: a filed action is never rewritten; a request starts pending and only moves along the
 * allowed transitions, so an approval becomes `consumed` once and from nowhere else than
 * `approved`, always carries the time it runs out, and nothing leaves a final state; a recorded
 * transition is never rewritten and can only be added for the change the request just made; and
 * an open request and its history cannot be deleted. A closed request can be deleted, so that
 * old history can be pruned one day without changing the file format.
 *
 * They are guards, not a lock: whoever can write the file can also drop them.
 */
const SCHEMA = `
CREATE TABLE inbox_requests (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id) BETWEEN 1 AND 64),
  system_id TEXT NOT NULL CHECK(length(system_id) BETWEEN 1 AND 128),
  action_kind TEXT NOT NULL CHECK(length(action_kind) BETWEEN 1 AND 128),
  action_hash TEXT NOT NULL CHECK(length(action_hash) = 64),
  action_json TEXT NOT NULL,
  display_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired', 'withdrawn', 'consumed')),
  requested_at INTEGER NOT NULL CHECK(requested_at BETWEEN 0 AND ${SAFE_INTEGER}),
  expires_at INTEGER CHECK(expires_at IS NULL OR expires_at BETWEEN 0 AND ${SAFE_INTEGER}),
  approval_expires_at INTEGER CHECK(approval_expires_at IS NULL OR approval_expires_at BETWEEN 0 AND ${SAFE_INTEGER}),
  changed_at INTEGER NOT NULL CHECK(changed_at BETWEEN 0 AND ${SAFE_INTEGER}),
  refused_uses INTEGER NOT NULL DEFAULT 0 CHECK(refused_uses BETWEEN 0 AND ${SAFE_INTEGER}),
  last_refused_json TEXT,
  CHECK(status <> 'approved' OR approval_expires_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX inbox_open_action ON inbox_requests(system_id, action_hash) WHERE status IN ('pending', 'approved');
CREATE INDEX inbox_by_status ON inbox_requests(status, requested_at, request_id);
CREATE INDEX inbox_by_change ON inbox_requests(changed_at, request_id);
CREATE INDEX inbox_by_system_time ON inbox_requests(system_id, requested_at);
CREATE TABLE inbox_transitions (
  request_id TEXT NOT NULL REFERENCES inbox_requests(request_id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  at INTEGER NOT NULL CHECK(at BETWEEN 0 AND ${SAFE_INTEGER}),
  note TEXT,
  PRIMARY KEY(request_id, sequence)
) STRICT;
CREATE TRIGGER inbox_request_is_immutable BEFORE UPDATE ON inbox_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.system_id IS NOT OLD.system_id
  OR NEW.action_kind IS NOT OLD.action_kind OR NEW.action_hash IS NOT OLD.action_hash
  OR NEW.action_json IS NOT OLD.action_json OR NEW.display_json IS NOT OLD.display_json
  OR NEW.requested_at IS NOT OLD.requested_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'a filed inbox request is immutable');
END;
CREATE TRIGGER inbox_request_transition BEFORE UPDATE OF status ON inbox_requests
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'expired', 'withdrawn'))
  OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'rejected', 'expired', 'withdrawn')))
BEGIN
  SELECT RAISE(ABORT, 'illegal inbox transition');
END;
CREATE TRIGGER inbox_transition_is_immutable BEFORE UPDATE ON inbox_transitions
BEGIN
  SELECT RAISE(ABORT, 'a recorded inbox transition is immutable');
END;
CREATE TRIGGER inbox_request_starts_pending BEFORE INSERT ON inbox_requests
WHEN NEW.status IS NOT 'pending' OR NEW.approval_expires_at IS NOT NULL OR NEW.refused_uses IS NOT 0
  OR NEW.last_refused_json IS NOT NULL OR NEW.changed_at IS NOT NEW.requested_at
BEGIN
  SELECT RAISE(ABORT, 'an inbox request must start pending');
END;
CREATE TRIGGER inbox_transition_follows_request BEFORE INSERT ON inbox_transitions
WHEN NEW.from_status IS NEW.to_status
  OR NOT EXISTS (SELECT 1 FROM inbox_requests WHERE request_id = NEW.request_id AND status = NEW.to_status)
  OR NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence), 0) + 1 FROM inbox_transitions WHERE request_id = NEW.request_id)
  OR NEW.from_status IS NOT (SELECT to_status FROM inbox_transitions WHERE request_id = NEW.request_id ORDER BY sequence DESC LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'an inbox transition must record the change the request just made');
END;
CREATE TRIGGER inbox_open_request_stays BEFORE DELETE ON inbox_requests
WHEN OLD.status IN ('pending', 'approved')
BEGIN
  SELECT RAISE(ABORT, 'an open inbox request cannot be deleted');
END;
CREATE TRIGGER inbox_open_history_stays BEFORE DELETE ON inbox_transitions
WHEN EXISTS (SELECT 1 FROM inbox_requests WHERE request_id = OLD.request_id AND status IN ('pending', 'approved'))
BEGIN
  SELECT RAISE(ABORT, 'the history of an open inbox request cannot be deleted');
END;
PRAGMA application_id = ${INBOX_APPLICATION_ID};
PRAGMA user_version = ${INBOX_USER_VERSION};
`;

/**
 * Creates the file complete or not at all. Two processes that open a missing inbox at the same
 * time both build a private copy; the first hard link wins and the other adopts it.
 */
function publishNewDatabase(path: string): void {
  const temporary = `${path}.${randomUUID()}.initializing`;
  closeSync(openSync(temporary, 'wx', 0o600));
  let candidate: DatabaseSync | undefined;
  try {
    candidate = new DatabaseSync(temporary);
    candidate.exec(`PRAGMA synchronous = FULL; BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    candidate.close();
    candidate = undefined;
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    candidate?.close();
    unlinkSync(temporary);
  }
}

/** True when the connection is an inbox of the version this code writes. */
export function isInboxDatabase(db: DatabaseSync): boolean {
  return db.prepare('PRAGMA application_id').get()?.application_id === INBOX_APPLICATION_ID
    && db.prepare('PRAGMA user_version').get()?.user_version === INBOX_USER_VERSION;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** True when SQLite gave up because another connection held the file for too long. */
export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error) || !('errcode' in error)) return false;
  const code = Number(error.errcode) & 255;
  return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

/**
 * One connection to the shared inbox file. SQLite owns locking and crash recovery; every write
 * runs in `BEGIN IMMEDIATE`, so concurrent processes take turns and each sees the other's result.
 * An existing file that is not an inbox (including an empty one, or a link) is never adopted or
 * reset: the constructor throws before anything is written.
 */
export class InboxDatabase {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #identity: { dev: bigint; ino: bigint };
  #checked = false;

  constructor(path: string, busyTimeoutMs: number) {
    this.path = path;
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      publishNewDatabase(path);
    }
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Inbox database must be a regular file');
    this.#identity = { dev: stat.dev, ino: stat.ino };
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;`);
      if (!isInboxDatabase(this.#db)) throw new Error('Unrecognized inbox database');
    } catch (error) {
      // A file that is merely busy is checked again inside every transaction.
      if (!isBusyError(error)) {
        this.#db.close();
        throw error;
      }
    }
  }

  /** Runs inside the write lock: the file is still the one that was opened, and it is an inbox. */
  #verify(): void {
    const current = lstatSync(this.path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) {
      throw new Error('Inbox database was replaced or removed');
    }
    if (!isInboxDatabase(this.#db)) throw new Error('Unrecognized inbox database');
    if (this.#checked) return;
    if (this.#db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new Error('Inbox database integrity check failed');
    this.#checked = true;
  }

  /** All of `work` is committed, or none of it. A thrown error rolls everything back. */
  transaction<T>(work: (db: DatabaseSync) => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#verify();
      const result = work(this.#db);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The original failure is the one worth reporting.
      }
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}
