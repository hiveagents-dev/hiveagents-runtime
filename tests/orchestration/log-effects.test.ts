import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { inspectManagedEffect } from '../../src/orchestration/log/effects.js';
import { EXECUTION_DDL } from '../../src/orchestration/log/execution-schema.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import { createTaskHandoff, runHandoff } from '../../src/orchestration/handoff/index.js';
import { isExecutionHalted } from '../../src/public/execution-halt.js';
import { canonical } from '../../src/routing/json.js';
import { digest } from '../../src/orchestration/log/encoding.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
import type { DecisionRunOptions } from '../../src/orchestration/decisions/types.js';
const identity = logDraft().identity;
const operation = { id: 'owned', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) };
const association = { identity, stepId: 'effect', effectKey: 'effect', operation };
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const files = logDirectory(); cleanup.push(files.cleanup); const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => database.close()); return { ...files, database }; }
function options(id: string, execute: DecisionRunOptions['execute']): DecisionRunOptions {
  return { id, binding: bindDecision({ input: { z: 'first', a: 'second' }, authority: null, inputVersion: '1', authorityVersion: '1' }), authorize: () => ({ decision: 'allow', reason: 'fixture', expiresAt: Date.now() + 10000 }), isCurrent: () => true, execute, verify: () => ({ verified: true, evidence: ['owned:verified'] }) };
}
it('actual runHandoff consults persisted effects even when the bundle omits unresolvedEffects', async () => {
  const { database } = fixture(), store = new LogDecisionStore({ database, association });
  await expect(new DecisionRunner(store).run(options('source', () => { throw Error('uncertain'); }))).rejects.toThrow();
  const bundle = createTaskHandoff({ id: 'bundle', goal: 'continue', requirements: [], context: null, source: { id: 'source', version: '1', digest: 'a'.repeat(64) }, destination: { id: 'receiver', version: '1' }, evidence: [], artifacts: [], pending: [], unresolvedEffects: [] });
  let effects = 0;
  await expect(runHandoff({ id: 'handoff', handoffId: 'bundle', store: { async save() {}, async load() { return bundle; } },
    decisionStore: new LogDecisionStore({ database, association: { ...association, effectKey: 'handoff', stepId: 'handoff' } }), target: bundle.destination,
    sourceDigest: bundle.source.digest, authority: { id: 'fixture', version: '1' }, authorize: () => ({ decision: 'allow', reason: 'fixture', expiresAt: Date.now() + 10000 }), isCurrent: () => true,
    execute: () => { effects++; return null; }, verify: () => ({ verified: true, evidence: ['none'] }),
  })).rejects.toThrow(); expect(effects).toBe(0);
});
it('retains compound child success and UNKNOWN; parent and unresolved child cannot resend', async () => {
  const { database } = fixture(); let first = 0, second = 0;
  const childA = { ...association, effectKey: 'child-a', parentEffectKey: 'parent' }, childB = { ...association, effectKey: 'child-b', parentEffectKey: 'parent' };
  expect((await new DecisionRunner(new LogDecisionStore({ database, association: childA })).run(options('a', () => { first++; return 'first-success'; }))).status).toBe('verified');
  await expect(new DecisionRunner(new LogDecisionStore({ database, association: childB })).run(options('b', () => { second++; throw Error('unknown-second'); }))).rejects.toThrow();
  expect(inspectManagedEffect(database, childA)?.record?.status).toBe('verified'); expect(inspectManagedEffect(database, childB)?.record?.status).toBe('needs-owner');
  await expect(new DecisionRunner(new LogDecisionStore({ database, association: { ...association, effectKey: 'parent' } })).run(options('parent', () => { first++; second++; return null; }))).rejects.toThrow();
  await expect(new DecisionRunner(new LogDecisionStore({ database, association: childB })).run(options('new-b', () => { second++; return null; }))).rejects.toThrow(); expect([first, second]).toEqual([1, 1]);
});
it('nested run-level callbacks fail immediately without circular waits or treating parentEffectKey as a grant', async () => {
  const { database } = fixture(); let children = 0;
  const parent = new LogDecisionStore({ database, association: { ...association, effectKey: 'parent' } });
  const child = new LogDecisionStore({ database, association: { ...association, effectKey: 'child', parentEffectKey: 'parent' } });
  let failure: unknown;
  try { await new DecisionRunner(parent).run(options('parent', async () => { await new DecisionRunner(child).run(options('child', () => { children++; return null; })); return null; })); } catch (error) { failure = error; }
  expect(children).toBe(0); expect(isExecutionHalted(failure)).toBe(true); expect(inspectManagedEffect(database, { ...association, effectKey: 'parent' })?.record?.status).toBe('needs-owner');
});
it('an intermediate materialized write failure rolls back the matching log event and stops before execute', async () => {
  const { database, file } = fixture(), store = new LogDecisionStore({ database, association }), original = DatabaseSync.prototype.prepare; let effects = 0;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) { if (sql.startsWith('INSERT INTO main.oar_execution_states')) throw Error('owned-materialization-fault'); return original.call(this, sql); });
  await expect(new DecisionRunner(store).run(options('decision', () => { effects++; return null; }))).rejects.toThrow(); vi.restoreAllMocks();
  expect(effects).toBe(0); expect(database.inspectOwnership('decision', identity)).toBeDefined();
  expect((await database.readPage()).items.filter(entry => entry.record.type.startsWith('decision.'))).toEqual([]);
  const db = new DatabaseSync(file); expect(db.prepare('SELECT * FROM oar_execution_states').all()).toEqual([]); db.close();
});
it('validates corrupted global association keys before excluding them from another effect', async () => {
  const { database, file } = fixture(), store = new LogDecisionStore({ database, association });
  await expect(new DecisionRunner(store).run(options('original', () => { throw Error('unknown'); }))).rejects.toThrow();
  const db = new DatabaseSync(file); db.exec('DROP TRIGGER oar_execution_effects_update'); db.exec("UPDATE oar_execution_effects SET effect_id=''"); db.exec(EXECUTION_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_execution_effects_update'))!);
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok'); db.close();
  let effects = 0; await expect(new DecisionRunner(new LogDecisionStore({ database, association: { ...association, effectKey: 'different' } })).run(options('other', () => { effects++; return null; }))).rejects.toThrow(); expect(effects).toBe(0);
});
it('rejects a materialized rollback to an older valid waiting record while later UNKNOWN remains in the log', async () => {
  const { database, file } = fixture(), store = new LogDecisionStore({ database, association }); let effects = 0;
  await new DecisionRunner(store).run({ ...options('same', () => null), condition: () => false });
  const db = new DatabaseSync(file), waiting = db.prepare('SELECT * FROM oar_execution_states').get()!;
  await expect(new DecisionRunner(store).run(options('same', () => { effects++; throw Error('unknown'); }))).rejects.toThrow();
  db.prepare('UPDATE oar_execution_states SET revision=?,record_json=?,record_digest=?,sequence=?,event_digest=?,request_id=?').run(waiting.revision!, waiting.record_json!, waiting.record_digest!, waiting.sequence!, waiting.event_digest!, waiting.request_id!);
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok'); expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]); db.close();
  await expect(new DecisionRunner(store).run(options('same', () => { effects++; return null; }))).rejects.toThrow(); expect(effects).toBe(1);
});
it('binds immutable association data to its original log append, not merely a mutable row checksum', async () => {
  const { database, file } = fixture(), store = new LogDecisionStore({ database, association });
  await new DecisionRunner(store).run({ ...options('same', () => null), condition: () => false });
  const db = new DatabaseSync(file), row = db.prepare('SELECT * FROM oar_execution_effects').get()!, changed = JSON.parse(String(row.association_json));
  changed.operation.targetDigest = 'f'.repeat(64); const encoded = canonical(changed);
  db.exec('DROP TRIGGER oar_execution_effects_update'); db.prepare('UPDATE oar_execution_effects SET association_json=?,association_digest=?').run(encoded, digest(encoded)); db.exec(EXECUTION_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_execution_effects_update'))!); db.close();
  let effects = 0; await expect(new DecisionRunner(new LogDecisionStore({ database, association: { ...association, operation: changed.operation } })).run(options('same', () => { effects++; return null; }))).rejects.toThrow(); expect(effects).toBe(0);
});
it('a saved lease on a closed data connection fails with a genuine halt, without native diagnostics', async () => {
  const { database } = fixture(), store = new LogDecisionStore({ database, association }), lease = await store.acquire('same'); database.close(); let failure: unknown;
  try { await lease.save({ format: 1, id: 'same', binding: options('same', () => null).binding, status: 'waiting', attempts: 0, reason: 'fixture' }); } catch (error) { failure = error; }
  expect(isExecutionHalted(failure)).toBe(true); await lease.release().catch(() => {});
});
