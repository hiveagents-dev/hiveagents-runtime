import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { executionContext, LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { SqliteLogBinding } from '../../src/orchestration/log/sqlite-binding.js';
import { LOG_DDL } from '../../src/orchestration/log/sqlite-schema.js';
import type { LogCommit } from '../../src/orchestration/log/types.js';
import { logCommit, logDirectory, logDraft } from './log-store-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function files() { const result = logDirectory(); cleanup.push(result.cleanup); return result; }
function open(file: string, execution: boolean) {
  if (!execution) {
    const store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' });
    cleanup.push(() => store.close()); return store;
  }
  const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' });
  cleanup.push(() => database.close());
  return { append: (commit: LogCommit) => database.captureStore.append(commit), readPage: () => database.readPage() };
}
function commit(requestId: string): LogCommit {
  return { requestId, records: [{ ...logDraft(), schema: { id: 'oar.sdk.capture-operation', version: 1 }, type: 'capture.started',
    payload: { inline: { mode: 'metadata-only', invocationDigest: 'b'.repeat(64),
      actual: { providerDigest: 'c'.repeat(64), attemptDigest: 'd'.repeat(64) }, stage: 'started' } } }] };
}

describe.each([false, true])('integrity scans (execution database: %s)', execution => {
  it('fully validates on open but does not scan during appends without external writes', async () => {
    const { file } = files(), prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const store = open(file, execution);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('quick_check'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('foreign_key_check'))).toBe(true);
    prepare.mockClear();
    await store.append(commit('one')); await store.append(commit('two')); await store.readPage();
    expect(prepare.mock.calls.some(([sql]) => /quick_check|foreign_key_check/.test(sql))).toBe(false);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('sqlite_schema'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('descriptor_json,descriptor_digest'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('application_id'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('user_version'))).toBe(true);
  });

  it('rescans after external commits and stops scanning once that version is validated', async () => {
    const { file } = files(), store = open(file, execution), other = open(file, execution);
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    for (const request of ['first', 'second']) {
      await other.append(commit(`external-${request}`)); prepare.mockClear();
      await store.append(commit(`local-${request}`));
      expect(prepare.mock.calls.some(([sql]) => sql.includes('quick_check'))).toBe(true);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('foreign_key_check(oar_log_events)'))).toBe(true);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('foreign_key_check(oar_log_payloads)'))).toBe(true);
      if (execution) expect(prepare.mock.calls.some(([sql]) => sql === 'PRAGMA main.foreign_key_check')).toBe(true);
      prepare.mockClear(); await store.append(commit(`stable-${request}`));
      expect(prepare.mock.calls.some(([sql]) => /quick_check|foreign_key_check/.test(sql))).toBe(false);
    }
    expect((await store.readPage()).items).toHaveLength(6);
  });

  it('rejects a trigger committed by another connection before appending', async () => {
    const { file } = files(), store = open(file, execution), other = new DatabaseSync(file);
    cleanup.push(() => other.close());
    other.exec('CREATE TRIGGER unexpected AFTER INSERT ON oar_log_events BEGIN SELECT 1; END');
    await expect(store.append(commit('rejected'))).rejects.toMatchObject({ code: execution ? 'EXECUTION_HALTED' : 'INTEGRITY' });
    expect(other.prepare('SELECT * FROM oar_log_events').all()).toEqual([]);
  });

  it('keeps rejecting externally committed foreign-key damage after a failed validation', async () => {
    const { file } = files(), store = open(file, execution), other = new DatabaseSync(file);
    cleanup.push(() => other.close()); other.exec('PRAGMA foreign_keys=OFF');
    if (execution) {
      other.exec(`INSERT INTO oar_execution_states VALUES ('decision','orphan','{}','digest',1,'{}','digest',999,'digest','absent')`);
    } else {
      other.exec(`INSERT INTO oar_log_payloads VALUES (999,'{}','digest')`);
    }
    expect(other.prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok');
    expect(other.prepare('PRAGMA foreign_key_check').all().length).toBeGreaterThan(0);
    const failure = execution ? { code: 'EXECUTION_HALTED', reason: 'INTEGRITY' } : { code: 'INTEGRITY' };
    await expect(store.readPage()).rejects.toMatchObject(failure);
    await expect(store.readPage()).rejects.toMatchObject(failure);
  });
});

it.each([false, true])('rescans after an owned read transaction without the native transaction getter (rollback: %s)', async rollback => {
  // Isolate the cached runtime probe; hide only the sample getter, without changing production APIs.
  vi.resetModules();
  const { LogConnection, publishLog } = await import('../../src/orchestration/log/sqlite-storage.js');
  const { file } = files(); publishLog(file, 'fixture');
  const db = new DatabaseSync(file); cleanup.push(() => db.close());
  const descriptor = Object.getOwnPropertyDescriptor;
  const probe = vi.spyOn(Object, 'getOwnPropertyDescriptor').mockImplementation((target, key) =>
    target instanceof DatabaseSync && key === 'isTransaction' ? undefined : descriptor(target, key));
  let connection: InstanceType<typeof LogConnection>;
  try { connection = new LogConnection(db, file, 'fixture', true); }
  finally { probe.mockRestore(); vi.resetModules(); }
  const other = new DatabaseSync(file); cleanup.push(() => other.close());
  const prepare = vi.spyOn(db, 'prepare');
  const version = db.prepare('PRAGMA main.data_version').get()!.data_version;
  const read = () => connection.transaction(() => {
    // BEGIN is deferred: commit before its first read establishes a snapshot.
    other.exec('PRAGMA user_version=1');
    expect(db.prepare('PRAGMA main.data_version').get()!.data_version).not.toBe(version);
    connection.assert();
    if (rollback) throw new Error('abort read');
  });
  if (rollback) expect(read).toThrow(); else read();
  expect(prepare.mock.calls.some(([sql]) => sql.includes('quick_check'))).toBe(true);
  prepare.mockClear(); connection.transaction(() => undefined);
  expect(prepare.mock.calls.some(([sql]) => sql.includes('quick_check'))).toBe(true);
  expect(prepare.mock.calls.some(([sql]) => sql.includes('foreign_key_check'))).toBe(true);
  prepare.mockClear(); connection.transaction(() => undefined);
  expect(prepare.mock.calls.some(([sql]) => /quick_check|foreign_key_check/.test(sql))).toBe(false);
});

it.each([false, true])('rescans execution tables after a commit inside an owned read transaction (rollback: %s)', async rollback => {
  const { file } = files(), database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' });
  cleanup.push(() => database.close());
  const context = executionContext(database), other = new DatabaseSync(file); cleanup.push(() => other.close());
  const prepare = vi.spyOn(context.db, 'prepare');
  const read = () => context.transaction(() => {
    other.exec('PRAGMA user_version=1');
    // Internal execution helpers can assert from inside the transaction body as well.
    context.assert();
    if (rollback) throw new Error('abort read');
  });
  if (rollback) expect(read).toThrow(); else read();
  expect(prepare.mock.calls.some(([sql]) => sql === 'PRAGMA main.foreign_key_check')).toBe(true);
  prepare.mockClear(); await database.readPage();
  expect(prepare.mock.calls.some(([sql]) => sql.includes('quick_check'))).toBe(true);
  expect(prepare.mock.calls.some(([sql]) => sql === 'PRAGMA main.foreign_key_check')).toBe(true);
  prepare.mockClear(); await database.readPage();
  expect(prepare.mock.calls.some(([sql]) => /quick_check|foreign_key_check/.test(sql))).toBe(false);
});

it('checks the descriptor on caller-owned connections even when data_version is unchanged', () => {
  const { file } = files(), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' }); cleanup.push(() => binding.close());
  db.exec('COMMIT'); const version = db.prepare('PRAGMA data_version').get()!.data_version;
  db.exec('DROP TRIGGER oar_log_meta_descriptor');
  db.exec("UPDATE oar_log_meta SET descriptor_digest='invalid'");
  db.exec(LOG_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_log_meta_descriptor'))!);
  expect(db.prepare('PRAGMA data_version').get()!.data_version).toBe(version);
  expect(() => binding.readPage()).toThrow('Invalid execution log');
});

it('checks the catalog on caller-owned connections even when data_version is unchanged', () => {
  const { file } = files(), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' }); cleanup.push(() => binding.close());
  db.exec('COMMIT'); const version = db.prepare('PRAGMA data_version').get()!.data_version;
  db.exec('CREATE TRIGGER unexpected AFTER INSERT ON oar_log_events BEGIN SELECT 1; END');
  expect(db.prepare('PRAGMA data_version').get()!.data_version).toBe(version);
  db.exec('BEGIN'); expect(() => binding.appendInTransaction(logCommit())).toThrow('Invalid execution log'); db.exec('ROLLBACK');
});

it('does not cache a successful validation of repairs that a caller can roll back', () => {
  const { file } = files(), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' }); cleanup.push(() => binding.close());
  db.exec('COMMIT');
  const other = new DatabaseSync(file); cleanup.push(() => other.close());
  other.exec("PRAGMA foreign_keys=OFF; INSERT INTO oar_log_payloads VALUES (999,'{}','digest')");
  db.exec('BEGIN; DROP TRIGGER oar_log_payloads_delete; DELETE FROM oar_log_payloads');
  db.exec(LOG_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_log_payloads_delete'))!);
  expect(binding.readPage().items).toEqual([]);
  db.exec('ROLLBACK');
  expect(() => binding.readPage()).toThrow('Invalid execution log');
});

// Found by the multi-model council review (2026-11-17): data_version never moves for
// commits on the same connection, so an enrolled caller connection could disable
// foreign keys, commit an orphan and re-enable them without the log noticing.
it('rejects foreign-key damage the caller committed on the same enrolled connection', () => {
  const { file } = files(), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' }); cleanup.push(() => binding.close());
  db.exec('COMMIT'); binding.readPage();
  const version = db.prepare('PRAGMA data_version').get()!.data_version;
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO oar_log_payloads VALUES (999,'{}','digest'); PRAGMA foreign_keys=ON");
  expect(db.prepare('PRAGMA data_version').get()!.data_version).toBe(version);
  expect(db.prepare('PRAGMA foreign_key_check(oar_log_payloads)').all().length).toBeGreaterThan(0);
  expect(() => binding.readPage()).toThrow('Invalid execution log');
});
