import { DatabaseSync } from 'node:sqlite';
import { ownObject } from '../../shared/json.js';
import { configuration } from './configuration.js';
import { SqliteLogBinding } from './sqlite-binding.js';
import { LogConnection, markSdkOwnedConnection } from './sqlite-storage.js';
import { publishExecutionDatabase } from './execution-storage.js';
import { validateExecutionSchema } from './execution-schema.js';
import { captureIdentity } from './reconstruction.js';
import { captureQuery, pageRecords } from './paging.js';
import { captureExecutionValue, runKey } from './execution-validation.js';
import { inspectOwner, recoverOwner } from './leases.js';
import { executionFailure, safeExecutionFailure } from './execution-types.js';
import type { ExecutionOwnership, LogExecutionDatabaseOptions, StandaloneStoppedAcknowledgement } from './execution-types.js';
import type { LogPage, LogQuery, LogSourceDescriptor } from './store-types.js';
import type { RunIdentity } from './types.js';
import { RecordCodec } from './record-codec.js';
import { executionCaptureStore } from './execution-capture.js';
import type { LogCommit, LogReceipt } from './types.js';

/** Private data-store plumbing, not a Host capability or a public arbitrary-SQL port. */
export interface ExecutionDatabaseContext {
  readonly db: DatabaseSync; readonly binding: SqliteLogBinding; readonly source: LogSourceDescriptor; readonly storageDigest: string; readonly codec: RecordCodec;
  assert(): void; transaction<T>(body: () => T, write?: boolean): T;
}
const contexts = new WeakMap<LogExecutionDatabase, ExecutionDatabaseContext>();
export function executionContext(database: LogExecutionDatabase): ExecutionDatabaseContext {
  const context = contexts.get(database); if (!context) executionFailure('INVALID_STATE'); context.assert(); return context;
}
/** Dedicated SQLite data database. All callbacks stay outside transactions; no execution issuer. */
export class LogExecutionDatabase {
  readonly sourceId: string; readonly descriptor: LogSourceDescriptor;
  readonly captureStore: Readonly<{ append(commit: LogCommit): Promise<LogReceipt> }>;
  readonly #db: DatabaseSync; readonly #binding: SqliteLogBinding; readonly #pin: LogConnection;
  readonly #codec: RecordCodec;
  #closed = false; #dataVersion: number; #ownedTransaction = false;
  constructor(options: LogExecutionDatabaseOptions) {
    let db: DatabaseSync | undefined;
    try {
      options = ownObject(options, ['databasePath', 'systemId', 'busyTimeoutMs', 'artifactStore', 'maxRecordBytes']);
      const config = configuration({ databasePath: options.databasePath, systemId: options.systemId, ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}) });
      this.#codec = new RecordCodec(options.artifactStore, options.maxRecordBytes); publishExecutionDatabase(config.databasePath, config.systemId, config.busyTimeoutMs);
      db = new DatabaseSync(config.databasePath); markSdkOwnedConnection(db);
      db.exec(`PRAGMA busy_timeout=${config.busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL`);
      const dataVersion = Number(db.prepare('PRAGMA main.data_version').get()!.data_version);
      validateExecutionSchema(db); this.#dataVersion = dataVersion; db.exec('BEGIN IMMEDIATE');
      this.#binding = new SqliteLogBinding(db, { databasePath: config.databasePath, systemId: config.systemId,
        ...(this.#codec.port ? { payloadVerifier: { verify: this.#codec.verify.bind(this.#codec) } } : {}) }); db.exec('COMMIT');
      this.#db = db; this.#pin = new LogConnection(db, config.databasePath, config.systemId, false);
      this.descriptor = this.#binding.descriptor; this.sourceId = this.descriptor.sourceId;
      for (const key of ['descriptor', 'sourceId']) Object.defineProperty(this, key, { writable: false, configurable: false });
      const context: ExecutionDatabaseContext = { db, binding: this.#binding, source: this.descriptor, storageDigest: this.#pin.storageDigest, codec: this.#codec,
        assert: () => this.#assert(), transaction: (body, write) => this.#transaction(body, write) };
      contexts.set(this, context); this.captureStore = executionCaptureStore(context);
      Object.defineProperty(this, 'captureStore', { writable: false, configurable: false }); this.#assert();
    } catch (error) { db?.close(); safeExecutionFailure(error); }
  }
  #assert(): void {
    if (this.#closed) executionFailure('CLOSED');
    try {
      this.#pin.assert(this.#ownedTransaction);
      // Keep a separate watermark: the log pin does not validate execution-table foreign keys.
      const dataVersion = Number(this.#db.prepare('PRAGMA main.data_version').get()!.data_version);
      validateExecutionSchema(this.#db, dataVersion !== this.#dataVersion);
      if (!this.#ownedTransaction && !this.#pin.inTransaction()) this.#dataVersion = dataVersion;
    } catch (error) { safeExecutionFailure(error); }
  }
  #transaction<T>(body: () => T, write = false): T {
    this.#assert(); let began = false;
    try {
      this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); began = true; this.#ownedTransaction = true;
      const result = body(); this.#assert(); this.#db.exec('COMMIT'); return result;
    } catch (error) {
      if (began) { try { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); } catch {} }
      return safeExecutionFailure(error);
    } finally { if (began) this.#ownedTransaction = false; }
  }
  async readPage(query: LogQuery = {}): Promise<LogPage> {
    const captured = captureQuery(query); return this.#transaction(() => pageRecords(this.#db, this.descriptor, this.#pin.storageDigest, captured));
  }
  inspectOwnership(kind: 'decision' | 'workflow', input: RunIdentity): ExecutionOwnership | undefined {
    const identity = captureIdentity(input); if (identity.systemId !== this.descriptor.systemId || !['decision', 'workflow'].includes(kind)) executionFailure('INVALID_STATE');
    return this.#transaction(() => inspectOwner(executionContext(this), kind, runKey(this.sourceId, identity)));
  }
  /** Trusted standalone operator acknowledgement. No PID/age inference and no Host stopped-work proof. */
  recoverAbandoned(expected: ExecutionOwnership, acknowledgement: StandaloneStoppedAcknowledgement): void {
    const captured = captureExecutionValue(expected), ack = captureExecutionValue(acknowledgement);
    if (!ack || typeof ack !== 'object' || Array.isArray(ack) || Object.keys(ack).length !== 1 || (ack as Record<string, unknown>).ownerStopped !== true) executionFailure('INVALID_STATE');
    this.#transaction(() => recoverOwner(executionContext(this), captured), true);
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#codec.close(); this.#binding.close(); this.#pin.close(); this.#db.close(); } }
}
