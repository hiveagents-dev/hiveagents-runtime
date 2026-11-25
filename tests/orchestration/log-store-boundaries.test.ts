import { afterEach, expect, it, vi } from 'vitest';
import { copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { SqliteLogBinding } from '../../src/orchestration/log/sqlite-binding.js';
import type { LogPayloadVerifier } from '../../src/orchestration/log/store-types.js';
import { logCommit, logDirectory, logDraft } from './log-store-fixture.js';
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function files() { const value = logDirectory(); cleanup.push(value.cleanup); return value; }
it('bounds pending work before capture and never writes after closing during artifact verification', async () => {
  const { file } = files(); let settle!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { settle = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const verifier: LogPayloadVerifier = { async verify(reference) { entered(); await blocked; return { kind: 'verified', reference }; } };
  const store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture', maxPending: 1, payloadVerifier: verifier }); cleanup.push(() => store.close());
  const pending = store.append({ requestId: 'not-written', records: [{ ...logDraft(), payload: { artifact: { sourceId: store.sourceId, systemId: 'fixture', generation: 1, bytes: 0, digest: 'b'.repeat(64), mediaType: 'application/json' } } }] });
  await started;
  let invoked = false; const bad = { get requestId() { invoked = true; return 'private'; }, records: [] };
  await expect(store.append(bad)).rejects.toMatchObject({ code: 'BUSY' }); expect(invoked).toBe(false);
  store.close(); settle(); await expect(pending).rejects.toMatchObject({ code: 'CLOSED' });
  const reopened = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => reopened.close());
  expect((await reopened.readPage()).scanned).toBe(0);
});
it('does not roll back a caller transaction when SAVEPOINT itself was rejected', () => {
  const { file } = files(), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' }); cleanup.push(() => binding.close()); db.exec('COMMIT; BEGIN');
  const original = DatabaseSync.prototype.exec, commands: string[] = [];
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    commands.push(sql); if (sql === 'SAVEPOINT oar_log_append') throw Error('private-savepoint-canary'); return original.call(this, sql);
  });
  expect(() => binding.appendInTransaction(logCommit())).toThrow('Invalid execution log');
  expect(commands).toEqual(['SAVEPOINT oar_log_append']); expect(db.isTransaction).toBe(true); db.exec('ROLLBACK');
});
it('rolls back the entire range and pins after an actual intermediate insert failure', () => {
  const { file } = files(), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture' }); cleanup.push(() => binding.close()); db.exec('COMMIT; BEGIN');
  const original = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('UPDATE main.oar_log_meta')) throw Error('private-write-canary'); return original.call(this, sql);
  });
  expect(() => binding.appendInTransaction({ requestId: 'atomic', records: [logDraft(), logDraft()] })).toThrow('Invalid execution log');
  expect(db.isTransaction).toBe(true); expect(db.prepare('SELECT * FROM oar_log_events').all()).toEqual([]); expect(db.prepare('SELECT * FROM oar_log_requests').all()).toEqual([]);
  db.exec('COMMIT');
});
it('refuses inode replacement even when the copied database contains identical source bytes', async () => {
  const { file, directory } = files(), store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => store.close()); await store.append(logCommit());
  const copy = join(directory, 'replacement.sqlite'); copyFileSync(file, copy); renameSync(copy, file);
  await expect(store.readPage()).rejects.toMatchObject({ code: 'INTEGRITY' }); await expect(store.append(logCommit('two'))).rejects.toMatchObject({ code: 'INTEGRITY' });
});
it('checks same-source causal links while retaining unresolved foreign references as incomplete DATA', async () => {
  const { file } = files(), store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture', supportedSchemas: [{ id: 'test', version: 1 }] }); cleanup.push(() => store.close());
  const first = await store.append(logCommit());
  await store.append({ requestId: 'second', records: [{ ...logDraft(), causal: [first.head] }] });
  await expect(store.append({ requestId: 'wrong-link', records: [{ ...logDraft(), causal: [{ ...first.head, digest: 'c'.repeat(64) }] }] })).rejects.toThrow();
  await store.append({ requestId: 'foreign-reference', records: [{ ...logDraft(), causal: [{ ...first.head, sourceId: 'foreign-source' }] }] });
  expect(await store.inspectRun(logDraft().identity)).toMatchObject({ kind: 'incomplete', issues: ['UNRESOLVED_CAUSAL_REFERENCE'] });
});
it('refuses extra log-table triggers rather than running unreviewed mutable hooks', async () => {
  const { file } = files(), store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => store.close());
  const db = new DatabaseSync(file); db.exec('CREATE TRIGGER unexpected AFTER INSERT ON oar_log_events BEGIN SELECT 1; END'); db.close();
  await expect(store.append(logCommit())).rejects.toMatchObject({ code: 'INTEGRITY' });
});
