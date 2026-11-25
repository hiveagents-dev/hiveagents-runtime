import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { createRunHistory } from '../../src/orchestration/log/run-history.js';
import { createRequiredLogCapture } from '../../src/orchestration/log/capture.js';
import { createLogAuditProjector } from '../../src/orchestration/log/audit-projector.js';
import { isExecutionHalted } from '../../src/public/execution-halt.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
import { SqliteLogBinding } from '../../src/orchestration/log/sqlite-binding.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
const identity = logDraft().identity, inputDigest = 'b'.repeat(64), outputDigest = 'c'.repeat(64);
function fixture() {
  const files = logDirectory(); cleanup.push(files.cleanup);
  const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => database.close());
  return { ...files, database, history: createRunHistory({ database }) };
}
it('shares Runtime capture, run lifecycle and audit in one durable source without another database', async () => {
  const { database, history } = fixture();
  const started = await history.begin({ identity, requestId: 'begin', inputDigest }); expect(started.kind).toBe('started');
  if (started.kind !== 'started') throw Error('expected start');
  const capture = createRequiredLogCapture({ store: database.captureStore, identity, actual: { provider: 'fixture', attemptId: 'one' } });
  await capture.run(async () => { await capture.observe({ type: 'context.compacted' }); });
  const completed = await history.complete(started.run, { requestId: 'complete', outputDigest });
  expect(completed).toMatchObject({ status: 'completed', identity, inputDigest, outputDigest });
  expect(await history.recover(identity)).toEqual(completed);
  expect(await history.begin({ identity, requestId: 'begin-again', inputDigest })).toEqual({ kind: 'existing', record: completed });
  const page = await database.readPage(); expect(page.items.map(item => item.record.type)).toEqual(['run.started', 'capture.started', 'context.compacted', 'capture.settled', 'run.completed']);
  expect(new Set(page.items.map(item => item.sourceId))).toEqual(new Set([database.sourceId]));
  const audit = await createLogAuditProjector({ reader: database, identity }).rebuild();
  expect(audit.items.filter(item => item.category === 'run')).toHaveLength(2);
  expect(audit.issues).not.toContain('UNKNOWN_SCHEMA');
  expect(Object.isFrozen(database.captureStore)).toBe(true);
});
it('an opened run never produces another execution handle, including a fresh database object', async () => {
  const { file, history, database } = fixture();
  await history.begin({ identity, requestId: 'begin', inputDigest });
  expect((await createLogAuditProjector({ reader: database, identity }).rebuild()).kind).toBe('incomplete');
  const other = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => other.close());
  const result = await createRunHistory({ database: other }).begin({ identity, requestId: 'begin', inputDigest });
  expect(result).toMatchObject({ kind: 'existing', record: { status: 'unknown' } }); expect('run' in result).toBe(false);
  await expect(history.begin({ identity: { ...identity, generation: 2 }, requestId: 'changed-generation', inputDigest })).rejects.toSatisfy(isExecutionHalted);
  await expect(history.begin({ identity, requestId: 'changed-input', inputDigest: outputDigest })).rejects.toSatisfy(isExecutionHalted);
});
it('requires the original private run handle and preserves the first terminal observation', async () => {
  const { history } = fixture(), started = await history.begin({ identity, requestId: 'begin', inputDigest });
  if (started.kind !== 'started') throw Error('expected start');
  for (const fake of [{}, { ...started.run }, new Proxy(started.run, {})]) await expect(history.complete(fake as never, { requestId: 'fake' })).rejects.toSatisfy(isExecutionHalted);
  const interrupted = await history.interrupt(started.run, { requestId: 'interrupt', reason: 'halted' });
  expect(interrupted.status).toBe('interrupted');
  expect(await history.interrupt(started.run, { requestId: 'interrupt-again', reason: 'halted' })).toEqual(interrupted);
  await expect(history.complete(started.run, { requestId: 'complete' })).rejects.toSatisfy(isExecutionHalted);
  expect(await history.list({ generation: 1 })).toEqual([interrupted]);
});
it('commit acknowledgement loss cannot mint a run handle or replay the open run', async () => {
  const { history } = fixture(), original = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    original.call(this, sql); if (sql === 'COMMIT') throw Error('private acknowledgement loss');
  });
  await expect(history.begin({ identity, requestId: 'begin', inputDigest })).rejects.toSatisfy(isExecutionHalted); spy.mockRestore();
  expect(await history.recover(identity)).toMatchObject({ status: 'unknown' });
  expect(await history.begin({ identity, requestId: 'retry', inputDigest })).toMatchObject({ kind: 'existing', record: { status: 'unknown' } });
});
it('bounds scans, rejects accessors/proxies without execution, and rejects fake lifecycle capture', async () => {
  const { database, history } = fixture(); let invoked = 0;
  const getter = { requestId: 'getter', inputDigest, get identity() { invoked++; return identity; } };
  await expect(history.begin(getter)).rejects.toSatisfy(isExecutionHalted);
  await expect(history.begin(new Proxy({ identity, requestId: 'proxy', inputDigest }, { get() { invoked++; throw Error(); } }))).rejects.toSatisfy(isExecutionHalted);
  expect(invoked).toBe(0);
  await expect(database.captureStore.append({ requestId: 'fake', records: [{ ...logDraft(), schema: { id: 'oar.system.run', version: 1 }, type: 'run.completed' }] })).rejects.toSatisfy(isExecutionHalted);
  const one = await history.begin({ identity, requestId: 'one', inputDigest }); if (one.kind !== 'started') throw Error();
  await history.complete(one.run, { requestId: 'two' });
  await expect(createRunHistory({ database, maxEntries: 1 }).recover(identity)).rejects.toSatisfy(isExecutionHalted);
  database.close(); await expect(history.recover(identity)).rejects.toSatisfy(isExecutionHalted);
});
it('reserves a terminal record for each open run before admitting another one', async () => {
  const { database } = fixture();
  const history = createRunHistory({ database, maxEntries: 3 });
  const started = await history.begin({ identity, requestId: 'start', inputDigest });
  if (started.kind !== 'started') throw Error('expected start');
  const other = { ...identity, runId: 'another' };
  await expect(history.begin({ identity: other, requestId: 'start-another', inputDigest }))
    .rejects.toMatchObject({ reason: 'CODEC_LIMIT' });
  await expect(history.complete(started.run, { requestId: 'finish' })).resolves.toMatchObject({ status: 'completed' });
  await expect(history.recover(identity)).resolves.toMatchObject({ status: 'completed' });
  await expect(history.recover(other)).resolves.toBeUndefined();
});
it('does not append an unreadable terminal when another producer consumed the headroom', async () => {
  const { database } = fixture();
  const history = createRunHistory({ database, maxEntries: 3 });
  const started = await history.begin({ identity, requestId: 'start', inputDigest });
  if (started.kind !== 'started') throw Error('expected start');
  const capture = createRequiredLogCapture({ store: database.captureStore, identity, actual: { provider: 'fixture', attemptId: 'one' } });
  await capture.run(async () => undefined);
  await expect(history.complete(started.run, { requestId: 'finish' })).rejects.toMatchObject({ reason: 'CODEC_LIMIT' });
  await expect(history.recover(identity)).resolves.toMatchObject({ status: 'unknown' });
  const expanded = createRunHistory({ database, maxEntries: 4 });
  await expect(expanded.recover(identity)).resolves.toMatchObject({ status: 'unknown' });
});
it('bounds admitted capture producers and captures their values before an awaited verifier', async () => {
  const { database } = fixture(); let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; }), original = SqliteLogBinding.prototype.prepare;
  const spy = vi.spyOn(SqliteLogBinding.prototype, 'prepare').mockImplementation(async function(this: SqliteLogBinding, commit) {
    await block; return original.call(this, commit);
  });
  const captured = createRequiredLogCapture({ store: database.captureStore, identity, actual: { provider: 'fixture', attemptId: 'one' } });
  const draft = logDraft();
  const commit = { requestId: 'metadata', records: [{ ...draft, identity: { ...draft.identity }, schema: { id: 'oar.sdk.capture-operation', version: 1 }, type: 'capture.started',
    payload: { inline: { mode: 'metadata-only', invocationDigest: 'e'.repeat(64), actual: { providerDigest: 'f'.repeat(64), attemptDigest: '0'.repeat(64) }, stage: 'started' } } }] };
  const one = database.captureStore.append(commit), two = database.captureStore.append({ ...commit, requestId: 'second' });
  const overflow = captured.run(async () => { throw Error('must not run'); });
  await expect(overflow).rejects.toSatisfy(isExecutionHalted);
  commit.records[0]!.identity.runId = 'mutated'; release(); await Promise.all([one, two]); spy.mockRestore();
  expect((await database.readPage()).items.map(item => item.record.identity.runId)).toEqual(['run', 'run']);
});
