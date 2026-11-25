import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x4f415242; // OARB: dedicated HiveAgents Runtime budget database.
/** Additive audit of operator clock acknowledgements. Created lazily in ledgers published before
 *  it existed, so a cooperating process on an older build keeps sharing the same version-1 file. */
export const CLOCK_AUDIT_TABLE = `
CREATE TABLE IF NOT EXISTS budget_clock_acknowledgements (
  provider_key TEXT NOT NULL REFERENCES budget_providers(provider_key),
  previous_observed_at INTEGER NOT NULL CHECK(previous_observed_at BETWEEN 0 AND 9007199254740991),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at BETWEEN 0 AND 9007199254740991),
  pid INTEGER NOT NULL CHECK(pid BETWEEN 0 AND 9007199254740991)
) STRICT;`;
/** A bounded watermark, maintained by SQLite even for an older process's prepared DELETE.
 * Once history was pruned, a clock acknowledgement must not reopen a window that needed it. */
const PRUNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_pruning_state (
  provider_key TEXT PRIMARY KEY REFERENCES budget_providers(provider_key),
  pruned_through INTEGER NOT NULL CHECK(pruned_through BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TRIGGER IF NOT EXISTS budget_track_pruning AFTER DELETE ON budget_reservations
BEGIN
  INSERT INTO budget_pruning_state(provider_key, pruned_through) VALUES (OLD.provider_key, OLD.admitted_at)
  ON CONFLICT(provider_key) DO UPDATE SET pruned_through = MAX(budget_pruning_state.pruned_through, excluded.pruned_through);
END;`;

function installPruningTracking(db: DatabaseSync): void {
  const tracked = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'budget_pruning_state'").get();
  db.exec(PRUNING_SCHEMA);
  // Before this tracker existed, a cooperating writer could have pruned through observed time minus
  // a day. There is no evidence of what was deleted: retain that conservative upper bound once.
  if (!tracked) db.exec(`INSERT INTO budget_pruning_state(provider_key, pruned_through)
    SELECT provider_key, last_observed_at - 86400000 FROM budget_providers WHERE last_observed_at >= 86400000;`);
}
const SCHEMA = `
CREATE TABLE budget_providers (
  provider_key TEXT PRIMARY KEY NOT NULL CHECK(length(provider_key) BETWEEN 1 AND 256),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent BETWEEN 0 AND 9007199254740991),
  max_hour INTEGER NOT NULL CHECK(max_hour BETWEEN 0 AND 9007199254740991),
  max_day INTEGER NOT NULL CHECK(max_day BETWEEN 0 AND 9007199254740991),
  cooldown_ms INTEGER NOT NULL CHECK(cooldown_ms BETWEEN 1 AND 9007199254740991),
  paused_until INTEGER NOT NULL CHECK(paused_until BETWEEN 0 AND 9007199254740991),
  last_observed_at INTEGER NOT NULL CHECK(last_observed_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE budget_reservations (
  token TEXT PRIMARY KEY NOT NULL,
  provider_key TEXT NOT NULL REFERENCES budget_providers(provider_key),
  owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 256),
  admitted_at INTEGER NOT NULL CHECK(admitted_at BETWEEN 0 AND 9007199254740991),
  released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0, 1))
) STRICT;
CREATE INDEX budget_reservations_provider_time ON budget_reservations(provider_key, admitted_at);
${CLOCK_AUDIT_TABLE}
${PRUNING_SCHEMA}
PRAGMA application_id = ${APPLICATION_ID};
PRAGMA user_version = 1;
`;

/** Publish a complete database atomically; an existing empty file is corruption,
 * never evidence that this caller is authorized to reset the ledger. A losing
 * first-open contender adopts the winner's fully initialized file. */
function publishNewDatabase(path: string): void {
  const temporary = `${path}.${randomUUID()}.initializing`;
  closeSync(openSync(temporary, 'wx', 0o600));
  let candidate: DatabaseSync | undefined;
  try {
    candidate = new DatabaseSync(temporary);
    candidate.exec(`PRAGMA synchronous = FULL; BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    candidate.close(); candidate = undefined;
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    candidate?.close();
    unlinkSync(temporary);
  }
}

/** SQLite owns locking and crash recovery. There is no age-based lock takeover. */
export class BudgetDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly identity: { dev: bigint; ino: bigint };
  #configured = false;
  #pruningReady = false;
  readonly #busyTimeoutMs: number;

  constructor(path: string, busyTimeoutMs: number) {
    this.path = path;
    this.#busyTimeoutMs = busyTimeoutMs;
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      publishNewDatabase(path);
    }
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Budget database must be a regular file');
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.db = new DatabaseSync(path);
    try {
      this.#configure();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.verify();
        installPruningTracking(this.db);
        this.db.exec('COMMIT'); this.#pruningReady = true;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      // A competing writer is temporary, not corruption. Keep this connection and its original
      // inode; every operation still verifies the complete ledger before admitting anything.
      const code = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
      if (typeof code !== 'number' || ![5, 6].includes(code & 255)) { this.db.close(); throw error; }
    }
  }

  #configure(): void {
    this.db.exec(`PRAGMA busy_timeout = ${this.#busyTimeoutMs}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;`);
    this.#configured = true;
  }

  verify(): void {
    const current = lstatSync(this.path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== this.identity.dev || current.ino !== this.identity.ino) {
      throw new Error('Budget database was replaced or removed');
    }
    if (this.db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
      || this.db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
      throw new Error('Unrecognized budget database version');
    }
    const check = this.db.prepare('PRAGMA quick_check(1)').get();
    if (check?.quick_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
      throw new Error('Budget database integrity check failed');
    }
  }

  /** Called inside this pinned connection's verified transaction. No mutable budget rows are hashed. */
  storageDigest(): string {
    const path = realpathSync(this.path);
    this.verify();
    return createHash('sha256').update(JSON.stringify(['oar-host-ledger', 1, APPLICATION_ID, path,
      String(this.identity.dev), String(this.identity.ino)])).digest('hex');
  }

  transaction<T>(work: (db: DatabaseSync) => T): T {
    if (!this.#configured) this.#configure();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.verify();
      if (!this.#pruningReady) installPruningTracking(this.db);
      const result = work(this.db);
      this.db.exec('COMMIT'); this.#pruningReady = true;
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Never turn uncertain storage into an admission. */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
