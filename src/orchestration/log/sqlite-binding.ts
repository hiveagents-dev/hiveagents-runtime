import type { DatabaseSync } from 'node:sqlite';
import { configuration, verifyCommit } from './configuration.js';
import type { Configuration } from './configuration.js';
import { capture } from './encoding.js';
import { captureQuery, pageRecords } from './paging.js';
import { appendRecords, lookupReceipt, readHead, requestIdentifier } from './records.js';
import { LogConnection } from './sqlite-storage.js';
import { logError, safeFailure } from './store-types.js';
import type { LogPage, LogQuery, LogSourceDescriptor, LogStoreOptions, PreparedLogCommit } from './store-types.js';
import type { LogCommit, LogReceipt } from './types.js';

const prepared = new WeakMap<object, { binding: SqliteLogBinding; commit: LogCommit }>();
/** Explicit app-database enrollment; needs native DatabaseSync.isTransaction (Node >=22.16).
 * All append writes stay inside the caller transaction. This is a data binding, not a host capability. */
export class SqliteLogBinding {
  readonly descriptor: LogSourceDescriptor; readonly sourceId: string;
  readonly #connection: LogConnection; readonly #config: Configuration; readonly #abort = new AbortController();
  #pending = 0;
  constructor(db: DatabaseSync, options: LogStoreOptions) {
    this.#config = configuration(options);
    try {
      this.#connection = new LogConnection(db, this.#config.databasePath, this.#config.systemId, false, true);
      this.descriptor = this.#connection.source; this.sourceId = this.descriptor.sourceId;
      readHead(db, this.descriptor);
      for (const key of ['descriptor', 'sourceId']) Object.defineProperty(this, key, { writable: false, configurable: false });
    } catch (error) { safeFailure(error); }
  }
  async prepare(input: LogCommit): Promise<PreparedLogCommit> {
    this.#connection.assert(); if (this.#connection.inTransaction()) logError('TRANSACTION_REQUIRED');
    if (this.#pending >= this.#config.maxPending) logError('BUSY');
    const commit = capture(input, this.descriptor); this.#pending++;
    try {
      await verifyCommit(commit, this.#config, this.descriptor, this.#abort.signal);
      this.#connection.assert(); if (this.#connection.inTransaction()) logError('TRANSACTION_REQUIRED');
      const handle = Object.freeze({}) as PreparedLogCommit; prepared.set(handle, { binding: this, commit }); return handle;
    } catch (error) { return safeFailure(error); } finally { this.#pending--; }
  }
  appendInTransaction(input: LogCommit | PreparedLogCommit): LogReceipt {
    this.#connection.assert(); if (!this.#connection.inTransaction()) logError('TRANSACTION_REQUIRED');
    const saved = input && typeof input === 'object' ? prepared.get(input) : undefined;
    if (saved && saved.binding !== this) logError('INVALID_INPUT');
    const commit = saved?.commit ?? capture(input, this.descriptor);
    if (!saved && commit.records.some(record => 'artifact' in record.payload)) logError('PAYLOAD_UNAVAILABLE');
    const db = this.#connection.db; let began = false;
    try {
      db.exec('SAVEPOINT oar_log_append'); began = true;
      const receipt = appendRecords(db, commit, this.descriptor); this.#connection.assert();
      db.exec('RELEASE oar_log_append'); began = false; return receipt;
    } catch (error) {
      if (began) { try { db.exec('ROLLBACK TO oar_log_append; RELEASE oar_log_append'); } catch {} }
      return safeFailure(error);
    }
  }
  lookupRequest(requestId: string): LogReceipt | undefined {
    requestIdentifier(requestId); return this.#connection.transaction(() => {
      readHead(this.#connection.db, this.descriptor); return lookupReceipt(this.#connection.db, requestId, this.descriptor)?.receipt;
    });
  }
  readPage(query: LogQuery = {}): LogPage {
    const captured = captureQuery(query);
    return this.#connection.transaction(() => pageRecords(this.#connection.db, this.descriptor, this.#connection.storageDigest, captured));
  }
  close(): void { this.#abort.abort(); this.#connection.close(); }
}
