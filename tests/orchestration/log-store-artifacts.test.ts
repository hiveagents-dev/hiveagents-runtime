import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { SqliteLogBinding } from '../../src/orchestration/log/sqlite-binding.js';
import type { LogPayloadVerifier } from '../../src/orchestration/log/store-types.js';
import type { LogCommit, PayloadReference } from '../../src/orchestration/log/types.js';
import { logCommit, logDirectory, logDraft } from './log-store-fixture.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function files() { const value = logDirectory(); cleanup.push(value.cleanup); return value; }
function artifact(sourceId: string, path: string): PayloadReference {
  const bytes = Buffer.from('real owned artifact á😀'); writeFileSync(path, bytes);
  return { sourceId, systemId: 'fixture', generation: 1, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mediaType: 'application/octet-stream' };
}
function verifier(file: string): LogPayloadVerifier { return { async verify(reference) {
  try { const bytes = readFileSync(file); return { reference, kind: bytes.length === reference.bytes && createHash('sha256').update(bytes).digest('hex') === reference.digest ? 'verified' : 'corrupt' }; }
  catch { return { reference, kind: 'missing' }; }
} }; }
function withArtifact(ref: PayloadReference): LogCommit { return { requestId: 'artifact', records: [{ ...logDraft(), payload: { artifact: ref } }] }; }
it('persists verified artifact pins but missing bytes or absent verifier make captured history incomplete', async () => {
  const { file, directory } = files(), payload = join(directory, 'owned.payload');
  const store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture', supportedSchemas: [{ id: 'test', version: 1 }], payloadVerifier: verifier(payload) }); cleanup.push(() => store.close());
  const ref = artifact(store.sourceId, payload), input = withArtifact(ref); await store.append(input);
  const db = new DatabaseSync(file); expect(db.prepare('SELECT * FROM oar_log_payloads').all()).toHaveLength(1); db.close();
  expect((await store.inspectRun(logDraft().identity)).kind).toBe('complete'); unlinkSync(payload);
  expect(await store.append(input)).toEqual(await store.lookupRequest('artifact'));
  expect(await store.inspectRun(logDraft().identity)).toMatchObject({ kind: 'incomplete', issues: ['PAYLOAD_MISSING'] }); store.close();
  const reader = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture', supportedSchemas: [{ id: 'test', version: 1 }] }); cleanup.push(() => reader.close());
  expect(await reader.inspectRun(logDraft().identity)).toMatchObject({ kind: 'incomplete', issues: ['PAYLOAD_UNVERIFIED'] });
});
it('prepares reference DATA outside caller TX; retries one genuine handle after rollback but refuses copied/foreign handles', async () => {
  const { file, directory } = files(), payload = join(directory, 'owned.payload'), db = new DatabaseSync(file); cleanup.push(() => db.close()); db.exec('BEGIN');
  const binding = new SqliteLogBinding(db, { databasePath: file, systemId: 'fixture', payloadVerifier: verifier(payload) }); cleanup.push(() => binding.close()); db.exec('COMMIT');
  const input = withArtifact(artifact(binding.sourceId, payload)), prepared = await binding.prepare(input);
  db.exec('BEGIN'); expect(() => binding.appendInTransaction(input)).toThrow(); expect(() => binding.appendInTransaction({ ...prepared })).toThrow();
  const first = binding.appendInTransaction(prepared); db.exec('ROLLBACK');
  expect(binding.lookupRequest('artifact')).toBeUndefined();
  db.exec('BEGIN'); expect(binding.appendInTransaction(prepared)).toEqual(first); db.exec('COMMIT');
  expect(binding.lookupRequest('artifact')).toEqual(first);
  const foreign = files(), otherDb = new DatabaseSync(foreign.file); cleanup.push(() => otherDb.close()); otherDb.exec('BEGIN');
  const other = new SqliteLogBinding(otherDb, { databasePath: foreign.file, systemId: 'fixture' }); cleanup.push(() => other.close());
  expect(() => other.appendInTransaction(prepared)).toThrow(); otherDb.exec('ROLLBACK');
});
it('denies reference appends without actual content verification and reports unknown schemas honestly', async () => {
  const { file, directory } = files(), store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => store.close());
  await expect(store.append(withArtifact(artifact(store.sourceId, join(directory, 'owned.payload'))))).rejects.toMatchObject({ code: 'PAYLOAD_UNAVAILABLE' });
  await store.append(logCommit()); expect(await store.inspectRun(logDraft().identity)).toMatchObject({ kind: 'incomplete', issues: ['UNKNOWN_SCHEMA'] });
  expect(await store.inspectRun({ ...logDraft().identity, runId: 'absent' })).toMatchObject({ kind: 'incomplete', eventCount: 0, issues: ['RUN_NOT_FOUND'] });
});
