import { DatabaseSync } from 'node:sqlite';
import { configuration, verifyCommit } from './configuration.js';
import type { Configuration } from './configuration.js';
import { capture } from './encoding.js';
import { captureQuery, pageRecords } from './paging.js';
import { appendRecords, lookupReceipt, readHead, requestIdentifier } from './records.js';
import { captureIdentity, reconstruct } from './reconstruction.js';
import { LogConnection, publishLog } from './sqlite-storage.js';
import { LogStoreError, logError, safeFailure } from './store-types.js';
import type { LogPage, LogQuery, LogSourceDescriptor, LogStoreOptions, RunReconstruction } from './store-types.js';
import type { LogCommit, LogReceipt, RunIdentity } from './types.js';

/** Exclusive standalone connection. SQLite locking and transactions own durability, not this queue. */
export class SqliteRunLogStore {
  readonly descriptor: LogSourceDescriptor; readonly sourceId: string;
  readonly #connection: LogConnection; readonly #config: Configuration; readonly #abort = new AbortController();
  #tail: Promise<unknown> = Promise.resolve(); #pending = 0; #closed = false;
  constructor(options: LogStoreOptions) {
    this.#config = configuration(options); let db: DatabaseSync | undefined;
    try {
      publishLog(this.#config.databasePath, this.#config.systemId);
      db = new DatabaseSync(this.#config.databasePath);
      db.exec(`PRAGMA busy_timeout=${this.#config.busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL`);
      this.#connection = new LogConnection(db, this.#config.databasePath, this.#config.systemId, true);
      this.descriptor = this.#connection.source; this.sourceId = this.descriptor.sourceId;
      this.#connection.transaction(() => readHead(db!, this.descriptor));
      for (const key of ['descriptor', 'sourceId']) Object.defineProperty(this, key, { writable: false, configurable: false });
    } catch (error) { db?.close(); safeFailure(error); }
  }
  #enqueue<T>(captureInput: () => () => T | Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new LogStoreError('CLOSED'));
    if (this.#pending >= this.#config.maxPending) return Promise.reject(new LogStoreError('BUSY'));
    let body: () => T | Promise<T>; try { body = captureInput(); } catch (error) { return Promise.reject(error); }
    this.#pending++;
    const operation = this.#tail.then(async () => { if (this.#closed) logError('CLOSED'); return body(); });
    this.#tail = operation.catch(() => {});
    return operation.catch(safeFailure).finally(() => { this.#pending--; });
  }
  append(input: LogCommit): Promise<LogReceipt> {
    return this.#enqueue(() => {
      const commit = capture(input, this.descriptor);
      return async () => {
        this.#connection.assert();
        // Replay is content-bound, but need not re-read already pinned payload bytes.
        const existing = this.#connection.transaction(() => lookupReceipt(this.#connection.db, commit.requestId, this.descriptor));
        if (!existing) await verifyCommit(commit, this.#config, this.descriptor, this.#abort.signal);
        this.#connection.assert();
        return this.#connection.transaction(() => appendRecords(this.#connection.db, commit, this.descriptor), true);
      };
    });
  }
  lookupRequest(requestId: string): Promise<LogReceipt | undefined> {
    return this.#enqueue(() => { requestIdentifier(requestId); return () => this.#connection.transaction(() => {
      readHead(this.#connection.db, this.descriptor); return lookupReceipt(this.#connection.db, requestId, this.descriptor)?.receipt;
    }); });
  }
  readPage(query: LogQuery = {}): Promise<LogPage> {
    return this.#enqueue(() => { const captured = captureQuery(query); return () => this.#page(captured); });
  }
  #page(query: LogQuery): LogPage {
    return this.#connection.transaction(() => pageRecords(this.#connection.db, this.descriptor, this.#connection.storageDigest, query));
  }
  inspectRun(input: RunIdentity): Promise<RunReconstruction> {
    return this.#enqueue(() => {
      const identity = captureIdentity(input);
      return async () => {
        const result = await reconstruct(identity, this.descriptor, this.#config, query => this.#page(query), ref => this.#connection.transaction(() =>
          this.#connection.db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(ref.sequence)?.digest === ref.digest), this.#abort.signal);
        this.#connection.assert(); return result;
      };
    });
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#abort.abort(); this.#connection.close(); } }
}
