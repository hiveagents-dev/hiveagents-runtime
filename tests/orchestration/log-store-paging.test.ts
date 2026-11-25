import { afterEach, expect, it } from 'vitest';
import { copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { LOG_DDL } from '../../src/orchestration/log/sqlite-schema.js';
import type { LogCursor } from '../../src/orchestration/log/store-types.js';
import { logCommit, logDirectory, logDraft } from './log-store-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const files = logDirectory(); cleanup.push(files.cleanup); const store = new SqliteRunLogStore({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => store.close()); return { ...files, store }; }
it('decodes global bounded pages before filters and drains empty continuations without omission', async () => {
  const { store } = fixture();
  await store.append({ requestId: 'other-generation', records: Array.from({ length: 256 }, () => logDraft(2)) });
  await store.append({ requestId: 'requested-generation', records: Array.from({ length: 70 }, () => logDraft(1)) });
  let cursor: LogCursor | undefined, scanned = 0, empty = 0; const sequences: number[] = [];
  do {
    const page = await store.readPage({ generation: 1, limit: 64, ...(cursor ? { cursor } : {}) });
    expect(page.scanned).toBeLessThanOrEqual(64); scanned += page.scanned;
    if (!page.items.length && page.nextCursor) empty++;
    sequences.push(...page.items.map(entry => entry.sequence)); cursor = page.nextCursor;
  } while (cursor);
  expect(scanned).toBe(326); expect(empty).toBe(4); expect(sequences).toEqual(Array.from({ length: 70 }, (_, index) => index + 257));
});
it('binds cursors to filters and physical storage, survives same-file reopen and fixes the captured head', async () => {
  const { store, file, directory } = fixture(); await store.append({ requestId: 'first', records: [logDraft(), logDraft(), logDraft()] });
  const page = await store.readPage({ generation: 1, limit: 1 }), cursor = page.nextCursor!;
  await expect(store.readPage({ generation: 2, cursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await store.append(logCommit('after-head')); store.close();
  const reopened = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => reopened.close());
  const rest = await reopened.readPage({ generation: 1, limit: 256, cursor }); expect(rest.items.map(item => item.sequence)).toEqual([2, 3]); expect(rest.through.sequence).toBe(3);
  const copiedPath = join(directory, 'copy.sqlite'); copyFileSync(file, copiedPath);
  const copied = new SqliteRunLogStore({ databasePath: copiedPath, systemId: 'fixture' }); cleanup.push(() => copied.close());
  expect(copied.sourceId).toBe(reopened.sourceId);
  await expect(copied.readPage({ generation: 1, cursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('refuses duplicate-key indexed corruption before excluding a nonmatching generation, with CHECKs intact', async () => {
  const { store, file } = fixture(); await store.append(logCommit());
  const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON; DROP TRIGGER oar_log_events_update');
  const body = String(db.prepare('SELECT body_json FROM oar_log_events WHERE sequence=1').get()!.body_json).replace('"generation":1', '"generation":2,"generation":1');
  const hash = createHash('sha256').update(body).digest('hex');
  db.prepare('UPDATE oar_log_events SET generation=2,body_json=?,digest=? WHERE sequence=1').run(body, hash);
  db.prepare('UPDATE oar_log_meta SET head_digest=? WHERE id=1').run(hash);
  db.exec(LOG_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_log_events_update'))!);
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok'); expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]); db.close();
  await expect(store.readPage({ generation: 1 })).rejects.toMatchObject({ code: 'INTEGRITY' });
  expect(await store.inspectRun(logDraft().identity)).toMatchObject({ scope: 'captured-history', kind: 'corrupt', issues: ['LOG_CORRUPT'] });
});
it.each([0, 257, 1.5, NaN])('rejects malformed limits without changing history: %s', async limit => {
  const { store } = fixture(); await expect(store.readPage({ limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('does not invoke query/cursor getters or proxies', async () => {
  const { store } = fixture(); let invoked = false;
  const value = { get limit() { invoked = true; return 1; } };
  await expect(store.readPage(value)).rejects.toThrow();
  await expect(store.readPage(new Proxy({}, { get() { invoked = true; throw Error('canary'); } }))).rejects.toThrow(); expect(invoked).toBe(false);
});
it('refuses damaged request receipts while paging, even when event chain and all CHECKs remain valid', async () => {
  const { store, file } = fixture(); await store.append(logCommit()); const db = new DatabaseSync(file);
  db.exec('DROP TRIGGER oar_log_requests_update'); db.prepare('UPDATE oar_log_requests SET receipt_digest=?').run('b'.repeat(64));
  db.exec(LOG_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_log_requests_update'))!); db.close();
  await expect(store.readPage()).rejects.toMatchObject({ code: 'INTEGRITY' });
});
