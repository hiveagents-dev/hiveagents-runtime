import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { isExecutionHalted } from '../../src/public/execution-halt.js';
import { LogExecutionDatabase, executionContext } from '../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { largeAssociation, largeFixture, largeIdentity, largeOptions } from './log-large-fixture.js';
import { canonical } from '../../src/routing/json.js';
import { digest } from '../../src/orchestration/log/encoding.js';
import { EXECUTION_DDL } from '../../src/orchestration/log/execution-schema.js';
import { ExecutionHaltedError } from '../../src/public/execution-halt.js';
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(...args: Parameters<typeof largeFixture>) { const value = await largeFixture(...args); cleanup.push(value.cleanup, () => value.database.close()); return value; }
async function expectHalt(work: Promise<unknown>) { let error: unknown; try { await work; } catch (caught) { error = caught; } expect(isExecutionHalted(error)).toBe(true); }
const result = { z: { text: 'á😀\r\n'.repeat(20000) }, a: 'kept-last' };
it.each(['missing', 'corrupt', 'unknown-codec'] as const)('$0 in a stored body never becomes cached success or a new effect', async mode => {
  const { database, store, directory, file } = await fixture(); let effects = 0;
  const options = largeOptions(() => { effects++; return result; }); expect((await new DecisionRunner(store).run(options)).status).toBe('verified');
  const raw = new DatabaseSync(file), state = raw.prepare("SELECT record_json FROM oar_execution_states WHERE kind='decision'").get()!, descriptor = JSON.parse(String(state.record_json));
  if (mode === 'unknown-codec') { descriptor.version = 99; raw.prepare("UPDATE oar_execution_states SET record_json=? WHERE kind='decision'").run(JSON.stringify(descriptor)); }
  else { const scope = readdirSync(directory)[0]!, target = join(directory, scope, `${descriptor.reference.digest}.blob`); if (mode === 'missing') unlinkSync(target); else writeFileSync(target, Buffer.alloc(descriptor.reference.bytes, 0x20)); }
  raw.close(); await expectHalt(new DecisionRunner(new LogDecisionStore({ database, association: largeAssociation })).run(options)); expect(effects).toBe(1);
}, 15000);
it('COMMIT-then-ACK loss keeps original IDs/body/pin and later rehydrates without redispatch', async () => {
  const { database, store, file, artifactStore, observe } = await fixture(); let effects = 0, armed = true;
  const original = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    original.call(this, sql); if (armed && sql === 'COMMIT' && this.prepare("SELECT 1 FROM oar_log_events WHERE schema_id='oar.execution.decision' AND json_extract(body_json,'$.record.type')='decision.verified'").get()) { armed = false; throw Error('owned-large-ackloss'); }
  });
  const options = largeOptions(() => { effects++; return result; }); await expectHalt(new DecisionRunner(store).run(options)); vi.restoreAllMocks();
  const raw = new DatabaseSync(file), row = raw.prepare("SELECT sequence,request_id FROM oar_execution_states WHERE kind='decision'").get()!;
  expect(raw.prepare('SELECT COUNT(*) AS count FROM oar_log_payloads').get()!.count).toBe(2); raw.close();
  const owner = database.inspectOwnership('decision', largeIdentity)!; expect(owner).toBeDefined(); database.recoverAbandoned(owner, { ownerStopped: true }); database.close();
  const reopened = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture', artifactStore }); cleanup.push(() => reopened.close());
  observe(reopened);
  const cached = await new DecisionRunner(new LogDecisionStore({ database: reopened, association: largeAssociation })).run(options);
  expect(cached.status).toBe('verified'); expect(cached.result).toEqual(result); expect(effects).toBe(1);
  const check = new DatabaseSync(file); expect(check.prepare("SELECT sequence,request_id FROM oar_execution_states WHERE kind='decision'").get()).toEqual(row); check.close();
}, 15000);
it('artifact operations run outside SQLite TX and owner loss after await cannot commit a body/ref', async () => {
  let value!: Awaited<ReturnType<typeof fixture>>;
  value = await fixture({ write: () => { const db = new DatabaseSync(value.file); db.exec("DELETE FROM oar_execution_leases WHERE kind='decision'"); db.close(); } });
  await expectHalt(new DecisionRunner(value.store).run(largeOptions(() => result)));
  expect(value.modes.length).toBeGreaterThan(0); expect(value.modes.every(mode => mode === false)).toBe(true);
  const db = new DatabaseSync(value.file); expect(db.prepare('SELECT * FROM oar_log_payloads').all()).toEqual([]); db.close();
});
it('release during a real staged save retains ownership and cannot claim callback drainage', async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const value = await fixture({ write: async () => { entered(); await held; } });
  let lease!: Awaited<ReturnType<LogDecisionStore['acquire']>>;
  const wrapped = { async acquire(id: string) { lease = await value.store.acquire(id); return lease; } };
  const running = new DecisionRunner(wrapped).run(largeOptions(() => result)); void running.catch(() => {});
  await started;
  try {
    await expectHalt(lease.release()); const owner = value.database.inspectOwnership('decision', largeIdentity)!; expect(owner).toBeDefined();
    expect(() => value.database.recoverAbandoned(owner, { ownerStopped: true })).toThrow();
  } finally { finish(); await running.catch(() => {}); }
});
it('an explicit decoding cap refuses oversized history without fallback to an empty checkpoint', async () => {
  const { database, store, artifactStore, file } = await fixture(); let effects = 0; const options = largeOptions(() => { effects++; return result; }); await new DecisionRunner(store).run(options); database.close();
  const restricted = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture', artifactStore, maxRecordBytes: 65536 }); cleanup.push(() => restricted.close());
  await expectHalt(new DecisionRunner(new LogDecisionStore({ database: restricted, association: largeAssociation })).run(options)); expect(effects).toBe(1);
});
it('binding loss during artifact await refuses the final log/materialized commit', async () => {
  let value!: Awaited<ReturnType<typeof fixture>>;
  value = await fixture({ write: () => {
    const db = new DatabaseSync(value.file), row = db.prepare('SELECT association_json FROM oar_execution_effects').get()!, changed = JSON.parse(String(row.association_json));
    changed.operation.targetDigest = 'f'.repeat(64); const text = canonical(changed);
    db.exec('DROP TRIGGER oar_execution_effects_update'); db.prepare('UPDATE oar_execution_effects SET association_json=?,association_digest=?').run(text, digest(text)); db.exec(EXECUTION_DDL.find(sql => sql.startsWith('CREATE TRIGGER oar_execution_effects_update'))!); db.close();
  } });
  await expectHalt(new DecisionRunner(value.store).run(largeOptions(() => result)));
  const db = new DatabaseSync(value.file); expect(db.prepare('SELECT * FROM oar_log_payloads').all()).toEqual([]); db.close();
});
it('a genuine read halt survives a simultaneous owner/storage validation failure', async () => {
  let value!: Awaited<ReturnType<typeof fixture>>, failRead = false;
  const original = new AggregateError([new ExecutionHaltedError({ observedUsage: { inputTokens: 11, costMeaning: 'unavailable' } })], 'original-private-halt');
  value = await fixture({ read: () => { if (failRead) { value.database.close(); throw original; } } });
  const options = largeOptions(() => result); await new DecisionRunner(value.store).run(options); failRead = true; let failure: unknown;
  try { await new DecisionRunner(value.store).run(options); } catch (error) { failure = error; }
  const contains = (error: unknown): boolean => error === original || error instanceof Error && (contains(error.cause) || error instanceof AggregateError && error.errors.some(contains));
  expect(contains(failure)).toBe(true); expect(isExecutionHalted(failure)).toBe(true);
});
