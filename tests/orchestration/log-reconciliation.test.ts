import { afterEach, expect, it, vi } from 'vitest';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LogExecutionDatabase, executionContext } from '../../src/orchestration/log/execution-database.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../src/public/execution-halt.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { inspectManagedEffect } from '../../src/orchestration/log/effects.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const files = logDirectory(); cleanup.push(files.cleanup); const target = join(files.directory, 'owned-report');
  const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => database.close());
  const association = { identity: logDraft().identity, stepId: 'report', effectKey: 'original', operation: { id: 'write', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
  const store = new LogDecisionStore({ database, association }), binding = bindDecision({ input: { z: 'original', a: 'target' }, authority: null, inputVersion: '1', authorityVersion: '1' });
  let effects = 0;
  await expect(new DecisionRunner(store).run({ id: 'original', binding, authorize: () => ({ decision: 'allow', reason: 'owned', expiresAt: Date.now() + 10000 }), isCurrent: () => true,
    execute: () => { effects++; const fd = openSync(target, 'wx', 0o600); try { writeSync(fd, 'owned-original'); fsyncSync(fd); } finally { closeSync(fd); } throw Error('interrupted after owned effect'); },
    verify: () => ({ verified: false, evidence: [] }) })).rejects.toThrow();
  const original = inspectManagedEffect(database, association)!.record!;
  return { ...files, database, target, association, binding, store, original, effects: () => effects };
}
it('reconciles original-target evidence with original intent/binding and an atomic public metadata fact', async () => {
  const f = await fixture(); let checks = 0;
  const options = { id: 'original', intentId: f.original.intentId!, binding: f.binding, async verifyApplied(context: any) {
    checks++; expect(context.record.intentId).toBe(f.original.intentId); expect(context.association.operation).toEqual(f.association.operation);
    return { verified: readFileSync(f.target, 'utf8') === 'owned-original', result: { applied: 'owned-original' }, evidence: ['owned-file:original'] };
  } };
  const result = await f.store.reconcile(options); expect(result.status).toBe('verified'); expect(result.intentId).toBe(f.original.intentId); expect(result.attempts).toBe(1); expect(f.effects()).toBe(1);
  expect(await f.store.reconcile(options)).toEqual(result); expect(checks).toBe(1);
  const facts = (await f.database.readPage({ limit: 256 })).items.filter(entry => entry.record.schema.id === 'oar.execution.reconciliation');
  expect(facts).toHaveLength(1); expect(facts[0]!.record.type).toBe('decision.reconciled'); expect(facts[0]!.record.causal).toHaveLength(2);
  expect(JSON.stringify(facts[0]!.record.payload)).not.toContain('owned-original'); expect(JSON.stringify(facts[0]!.record.payload)).not.toContain('owned-file:original');
});
it('negative verification never resets unknown to waiting or supplies a fresh attempt', async () => {
  const f = await fixture(); const result = await f.store.reconcile({ id: 'original', intentId: f.original.intentId!, binding: f.binding, verifyApplied: () => ({ verified: false, evidence: [] }) });
  expect(result.status).toBe('needs-owner'); expect(result.attempts).toBe(1); expect(f.effects()).toBe(1);
});
it.each(['intent', 'binding', 'id'])('rejects changed original %s before invoking its target verifier', async field => {
  const f = await fixture(); let called = false;
  const input = { id: field === 'id' ? 'other' : 'original', intentId: field === 'intent' ? 'other' : f.original.intentId!,
    binding: field === 'binding' ? bindDecision({ input: null, authority: null, inputVersion: '1', authorityVersion: '1' }) : f.binding,
    verifyApplied: () => { called = true; return { verified: true, result: null, evidence: ['original'] }; } };
  await expect(f.store.reconcile(input)).rejects.toSatisfy(isExecutionHalted); expect(called).toBe(false); expect(f.effects()).toBe(1);
});
it('keeps a genuine verifier halt and drains its callback before releasing run ownership', async () => {
  const f = await fixture(), original = new ExecutionHaltedError(); let finish!: () => void;
  const pause = new Promise<void>(resolve => { finish = resolve; });
  const pending = f.store.reconcile({ id: 'original', intentId: f.original.intentId!, binding: f.binding,
    async verifyApplied() { await pause; throw original; } });
  await new Promise(resolve => setTimeout(resolve, 5)); const owner = f.database.inspectOwnership('decision', f.association.identity)!;
  expect(owner).toBeDefined(); expect(() => f.database.recoverAbandoned(owner, { ownerStopped: true })).toThrow();
  finish(); await expect(pending).rejects.toBe(original); expect(f.database.inspectOwnership('decision', f.association.identity)).toBeUndefined();
});
it('rejects a forged result descriptor without invoking getters or overwriting UNKNOWN', async () => {
  const f = await fixture(); let calls = 0;
  await expect(f.store.reconcile({ id: 'original', intentId: f.original.intentId!, binding: f.binding,
    verifyApplied: () => Object.defineProperty({ verified: true, evidence: ['original'] }, 'result', { enumerable: true, get() { calls++; return null; } }) as any,
  })).rejects.toSatisfy(isExecutionHalted);
  expect(calls).toBe(0); expect(inspectManagedEffect(f.database, f.association)!.record!.status).toBe('needs-owner');
});
it('lost COMMIT acknowledgement leaves original verified fact and holds exact owner without running verifier twice', async () => {
  const f = await fixture(), context = executionContext(f.database), real = context.db.exec.bind(context.db); let lost = false, calls = 0;
  const spy = vi.spyOn(context.db, 'exec').mockImplementation(sql => {
    const commit = sql === 'COMMIT' && context.db.prepare("SELECT record_json FROM main.oar_execution_states WHERE kind='decision'").get()?.record_json;
    real(sql); if (!lost && typeof commit === 'string' && JSON.parse(commit).status === 'verified') { lost = true; throw Error('owned commit acknowledgement lost'); }
  });
  const options = { id: 'original', intentId: f.original.intentId!, binding: f.binding, verifyApplied() { calls++; return { verified: true, result: { applied: true }, evidence: ['original'] }; } };
  await expect(f.store.reconcile(options)).rejects.toSatisfy(isExecutionHalted); spy.mockRestore(); expect(lost).toBe(true);
  expect(inspectManagedEffect(f.database, f.association)!.record!.status).toBe('verified');
  const owner = f.database.inspectOwnership('decision', f.association.identity)!; expect(owner).toBeDefined();
  await expect(f.store.reconcile(options)).rejects.toSatisfy(isExecutionHalted); expect(calls).toBe(1);
  // This fixture observed actual callback drainage; this is not Host proof.
  f.database.recoverAbandoned(owner, { ownerStopped: true });
  expect((await f.store.reconcile(options)).status).toBe('verified'); expect(calls).toBe(1); expect(f.effects()).toBe(1);
  expect((await f.database.readPage({ limit: 256 })).items.filter(e => e.record.type === 'decision.reconciled')).toHaveLength(1);
});
