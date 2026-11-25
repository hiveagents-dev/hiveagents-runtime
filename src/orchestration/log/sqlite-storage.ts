import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { digest } from './encoding.js';
import { LOG_APPLICATION_ID, LOG_SCHEMA_VERSION, installLogSchema, validateLogSchema } from './sqlite-schema.js';
import { logError, safeFailure } from './store-types.js';
import type { LogSourceDescriptor } from './store-types.js';

export function validPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) logError('INVALID_INPUT');
}
function stat(path: string) {
  const value = lstatSync(path, { bigint: true }); if (!value.isFile() || value.isSymbolicLink()) logError('INTEGRITY'); return value;
}
let checkedRuntime = false, nativeTransactionGetter: ((this: DatabaseSync) => boolean) | undefined;
function transactionGetter(db: DatabaseSync, required: boolean): (() => boolean) | undefined {
  if (!checkedRuntime) {
    const sample = new DatabaseSync(':memory:');
    try { nativeTransactionGetter = Object.getOwnPropertyDescriptor(sample, 'isTransaction')?.get; checkedRuntime = true; }
    finally { sample.close(); }
  }
  if (!nativeTransactionGetter) { if (required) logError('UNSUPPORTED_RUNTIME'); return undefined; }
  const getter = nativeTransactionGetter.bind(db); getter(); return getter;
}
export function publishLog(path: string, systemId: string): void {
  try { lstatSync(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.initializing`; closeSync(openSync(temporary, 'wx', 0o600));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(temporary); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    installLogSchema(db, systemId); db.exec(`PRAGMA application_id=${LOG_APPLICATION_ID}; PRAGMA user_version=${LOG_SCHEMA_VERSION}; COMMIT`); db.close(); db = undefined;
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { db?.close(); unlinkSync(temporary); }
}
/** Pins data storage, not an OS sandbox or authorization identity. */
// Connections the SDK opened itself and never hands to application code (for
// example LogExecutionDatabase's own connection, which it enrolls through a
// binding internally). Only these may skip the per-assert full check.
const sdkOwnedConnections = new WeakSet<DatabaseSync>();
/** Internal: mark a connection the SDK created and keeps private. */
export function markSdkOwnedConnection(db: DatabaseSync): void { sdkOwnedConnections.add(db); }
export class LogConnection {
  readonly source: LogSourceDescriptor; readonly storageDigest: string;
  readonly #dev: bigint; readonly #ino: bigint; readonly #canonicalPath: string; readonly #transactionGetter: (() => boolean) | undefined;
  #closed = false; #dataVersion: number; #ownedTransaction = false;
  // Enrolled (caller-owned) connections run application SQL on this same
  // connection, and data_version never reports same-connection commits: a caller
  // can disable foreign keys, commit an orphan and re-enable them unseen. Those
  // connections keep the full check on every assert.
  readonly #alwaysFull: boolean;
  constructor(readonly db: DatabaseSync, readonly path: string, readonly systemId: string, readonly standalone: boolean, enroll = false) {
    this.#alwaysFull = enroll && !sdkOwnedConnections.has(db);
    try {
      validPath(path); if (types.isProxy(db) || !(db instanceof DatabaseSync)) logError('INVALID_INPUT');
      this.#transactionGetter = transactionGetter(db, !standalone);
      if (enroll && !this.inTransaction()) logError('TRANSACTION_REQUIRED');
      const info = stat(path); this.#dev = info.dev; this.#ino = info.ino; this.#canonicalPath = realpathSync(path);
      const actual = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
      if (!actual || realpathSync(String(actual.file)) !== this.#canonicalPath) logError('INTEGRITY');
      // Sample before validation so an intervening external commit is never marked as checked.
      const dataVersion = Number(db.prepare('PRAGMA main.data_version').get()!.data_version);
      if (enroll) {
        let began = false;
        try {
          db.exec('SAVEPOINT oar_log_enroll'); began = true; installLogSchema(db, systemId);
          this.source = validateLogSchema(db, systemId, standalone); db.exec('RELEASE oar_log_enroll'); began = false;
        } catch (error) {
          if (began) { try { db.exec('ROLLBACK TO oar_log_enroll; RELEASE oar_log_enroll'); } catch {} } throw error;
        }
      } else this.source = validateLogSchema(db, systemId, standalone);
      this.#dataVersion = dataVersion;
      this.storageDigest = digest(`oar-log-storage-v1\n${this.#canonicalPath}\n${info.dev}\n${info.ino}`);
    } catch (error) { safeFailure(error); }
  }
  inTransaction(): boolean { return this.#ownedTransaction || (this.#transactionGetter?.() ?? false); }
  assert(insideTransaction = false): void {
    if (this.#closed) logError('CLOSED');
    try {
      const info = stat(this.path); if (info.dev !== this.#dev || info.ino !== this.#ino || realpathSync(this.path) !== this.#canonicalPath) logError('INTEGRITY');
      // Own commits do not change data_version. Catalog/descriptor/file guards still run every time;
      // on SDK-owned connections page and foreign-key corruption introduced by this connection is
      // checked again on reopen. Enrolled connections always run the full check (see #alwaysFull).
      const dataVersion = Number(this.db.prepare('PRAGMA main.data_version').get()!.data_version);
      const source = validateLogSchema(this.db, this.systemId, this.standalone, this.#alwaysFull || dataVersion !== this.#dataVersion);
      if (source.sourceId !== this.source.sourceId) logError('INTEGRITY');
      // Only cache checks outside both SDK-owned and caller-owned transactions.
      if (!insideTransaction && !this.inTransaction()) this.#dataVersion = dataVersion;
    } catch (error) { safeFailure(error); }
  }
  close(): void { if (!this.#closed) { this.#closed = true; if (this.standalone) this.db.close(); } }
  /** Only rolls back a transaction that this invocation successfully began. */
  transaction<T>(body: () => T, write = false): T {
    this.assert(); if (this.inTransaction()) { const result = body(); this.assert(); return result; }
    let began = false;
    try { this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); began = true; this.#ownedTransaction = true; const result = body(); this.assert(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (began) { try { if (!this.#transactionGetter || this.inTransaction()) this.db.exec('ROLLBACK'); } catch {} } return safeFailure(error); }
    finally { if (began) this.#ownedTransaction = false; }
  }
}
