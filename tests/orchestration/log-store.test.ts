import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { SqliteLogBinding } from '../../src/orchestration/log/sqlite-binding.js';
import type { LogCommit } from '../../src/orchestration/log/types.js';

const directories: string[] = [], stores: { close(): void }[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), 'oar-neutral-log-')); directories.push(dir); return join(dir, 'log.sqlite'); }
function open(databasePath = path()) { const store = new SqliteRunLogStore({ databasePath, systemId: 'fixture', supportedSchemas: [{ id: 'test', version: 1 }] }); stores.push(store); return store; }
function commit(requestId = 'one', generation = 1): LogCommit {
  return { requestId, records: [{ identity: { systemId: 'fixture', generation, runId: 'run', agentId: 'agent', harness: { id: 'sdk', version: 'dev', digest: 'a'.repeat(64) } }, schema: { id: 'test', version: 1 }, type: 'captured', causal: [], payload: { inline: { text: 'á😀\r\n' } } }] };
}
it('persists a source, immutable canonical events and exact request receipts across reopen', async () => {
  const file = path(), store = open(file), source = store.sourceId, input = commit();
  const receipt = await store.append(input); expect(receipt.count).toBe(1); expect(receipt.first.sequence).toBe(1);
  expect(await store.append(input)).toEqual(receipt); expect(await store.lookupRequest('one')).toEqual(receipt);
  await expect(store.append({ ...input, records: [{ ...input.records[0]!, type: 'changed' }] })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  const page = await store.readPage(); expect(page.scanned).toBe(1); expect(page.items[0]!.record).toEqual(input.records[0]);
  expect(Object.isFrozen(page.items[0]!.record)).toBe(true); store.close();
  const reopened = open(file); expect(reopened.sourceId).toBe(source); expect(await reopened.lookupRequest('one')).toEqual(receipt);
  expect(await reopened.inspectRun(input.records[0]!.identity)).toMatchObject({ scope: 'captured-history', kind: 'complete', eventCount: 1 });
});
it('does not reset existing empty, foreign or unknown-version databases', () => {
  const empty = path(); writeFileSync(empty, ''); expect(() => open(empty)).toThrow();
  const foreign = path(), db = new DatabaseSync(foreign); db.exec('CREATE TABLE application_state(id INTEGER);'); db.close(); expect(() => open(foreign)).toThrow();
  const unknown = path(), first = open(unknown); first.close(); const edit = new DatabaseSync(unknown); edit.exec('PRAGMA user_version=99'); edit.close(); expect(() => open(unknown)).toThrow();
});
it('a COMMIT-then-ACK error is discoverable and retries never allocate a second range', async () => {
  const file = path(), store = open(file), original = DatabaseSync.prototype.exec; let armed = true;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    original.call(this, sql); if (armed && sql === 'COMMIT' && this.prepare('SELECT COUNT(*) AS count FROM oar_log_requests').get()!.count === 1) { armed = false; throw Error('private-ack-canary'); }
  });
  await expect(store.append(commit())).rejects.toMatchObject({ code: 'STORAGE' });
  const receipt = await store.lookupRequest('one'); expect(receipt?.head.sequence).toBe(1);
  expect(await store.append(commit())).toEqual(receipt); expect((await store.readPage()).scanned).toBe(1);
});
it('binds app state and log to one caller-owned transaction without committing or rolling it back', () => {
  const file = path(), db = new DatabaseSync(file); db.exec('CREATE TABLE app_state(value TEXT); BEGIN IMMEDIATE');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' });
  db.exec("INSERT INTO app_state VALUES ('retained')"); binding.appendInTransaction(commit()); db.exec('COMMIT');
  db.exec('BEGIN IMMEDIATE'); binding.appendInTransaction(commit('rollback')); db.exec("INSERT INTO app_state VALUES ('rollback')"); db.exec('ROLLBACK');
  expect(binding.lookupRequest('one')?.head.sequence).toBe(1); expect(binding.lookupRequest('rollback')).toBeUndefined();
  expect(db.prepare('SELECT * FROM app_state').all()).toHaveLength(1);
  expect(() => binding.appendInTransaction(commit('outside'))).toThrow(); expect(db.isTransaction).toBe(false);
  binding.close(); expect(db.isOpen).toBe(true); db.close();
});
it('refuses enrollment outside a caller transaction and leaves foreign transaction failures intact', () => {
  const file = path(), db = new DatabaseSync(file); db.exec('CREATE TABLE app_state(value TEXT)');
  expect(() => new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' })).toThrow();
  db.exec("BEGIN; INSERT INTO app_state VALUES ('owned')");
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' });
  expect(() => binding.appendInTransaction({ ...commit(), requestId: '' })).toThrow();
  expect(db.isTransaction).toBe(true); expect(db.prepare('SELECT * FROM app_state').all()).toHaveLength(1);
  db.exec('ROLLBACK'); binding.close(); db.close();
});
it('captures inputs safely and refuses foreign systems and foreign artifact sources', async () => {
  const store = open(), input = commit(); let invoked = false;
  const unsafe = { get requestId() { invoked = true; throw Error('secret'); }, records: input.records };
  await expect(store.append(unsafe as unknown as LogCommit)).rejects.toThrow('Invalid execution log'); expect(invoked).toBe(false);
  await expect(store.append({ ...input, records: [{ ...input.records[0]!, identity: { ...input.records[0]!.identity, systemId: 'foreign' } }] })).rejects.toThrow();
  await expect(store.append({ ...input, records: [{ ...input.records[0]!, payload: { artifact: { sourceId: 'foreign', systemId: 'fixture', generation: 1, digest: 'b'.repeat(64), bytes: 1, mediaType: 'application/json' } } }] })).rejects.toThrow();
});
it('does not invoke a supported-schema proxy while validating constructor options', () => {
  let invoked = false;
  const supportedSchemas = new Proxy([], { get() { invoked = true; throw Error('private-schema-canary'); } });
  expect(() => new SqliteRunLogStore({ databasePath: path(), systemId: 'fixture', supportedSchemas })).toThrow('Invalid execution log');
  expect(invoked).toBe(false);
});
it('keeps unrelated deferred app foreign keys outside the enrolled log integrity check', () => {
  const file = path(), db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' });
  db.exec('INSERT INTO child VALUES(1)'); binding.appendInTransaction(commit()); db.exec('INSERT INTO parent VALUES(1); COMMIT');
  expect(binding.lookupRequest('one')?.count).toBe(1); binding.close(); db.close();
});
it('rolls back only its partial enrollment on failure, retaining the caller transaction and app changes', () => {
  const file = path(), db = new DatabaseSync(file), original = DatabaseSync.prototype.prepare;
  db.exec("CREATE TABLE app_state(value TEXT); BEGIN; INSERT INTO app_state VALUES ('owned')");
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO main.oar_log_meta')) throw Error('private-enrollment-canary'); return original.call(this, sql);
  });
  expect(() => new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' })).toThrow('Invalid execution log');
  expect(db.isTransaction).toBe(true); expect(db.prepare('SELECT * FROM app_state').all()).toHaveLength(1);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'oar_log_*'").all()).toHaveLength(0);
  db.exec('ROLLBACK'); db.close();
});
it('keeps exposed source descriptors immutable at runtime', () => {
  const store = open(); expect(() => Object.defineProperty(store, 'descriptor', { value: {} })).toThrow();
  expect(() => Object.defineProperty(store, 'sourceId', { value: 'rebound' })).toThrow();
});
