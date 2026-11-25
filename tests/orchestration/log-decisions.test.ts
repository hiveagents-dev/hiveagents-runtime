import { afterEach, expect, it } from 'vitest';
import { logDirectory } from './log-store-fixture.js';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import type { RunIdentity } from '../../src/orchestration/log/types.js';

const identity: RunIdentity = { systemId: 'fixture', generation: 1, runId: 'run', agentId: 'agent', harness: { id: 'sdk', version: 'dev', digest: 'a'.repeat(64) } };
const association = { identity, stepId: 'publish', effectKey: 'stable-effect', operation: { id: 'owned-write', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64), provider: 'fixture', model: 'local' } };
const binding = () => bindDecision({ input: { z: 'first', a: 'second' }, authority: { local: true }, inputVersion: '1', authorityVersion: '1' });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const files = logDirectory(); cleanup.push(files.cleanup); const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => database.close()); return { ...files, database, store: new LogDecisionStore({ database, association }) }; }
function options(execute: () => any) { return { id: 'decision', binding: binding(), now: () => 100, authorize: () => ({ decision: 'allow' as const, reason: 'owned fixture', expiresAt: 200 }), isCurrent: () => true, execute, verify: () => ({ verified: true, evidence: ['owned:file:digest'] }) }; }
it('actual DecisionRunner atomically persists transitions and cached original result across a new database instance', async () => {
  const { store, database, file } = fixture(); let effects = 0;
  const input = options(() => { effects++; return { z: 'original', a: 'result' }; });
  const first = await new DecisionRunner(store).run(input); expect(first.status).toBe('verified'); expect(effects).toBe(1);
  const page = await database.readPage(); expect(page.items.map(entry => entry.record.type)).toContain('decision.verified');
  const verified = page.items.find(entry => entry.record.type === 'decision.verified')!.record.payload as any;
  expect(verified.inline.metadata).toMatchObject({ kind: 'decision', status: 'verified', attempts: 1 });
  expect(JSON.stringify(verified.inline.metadata)).not.toContain('original'); expect(JSON.stringify(verified.inline.metadata)).not.toContain('owned:file');
  database.close(); const reopened = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => reopened.close());
  const cached = await new DecisionRunner(new LogDecisionStore({ database: reopened, association })).run({ ...input, execute: () => { throw Error('must not replay'); } });
  expect(cached).toEqual(first); expect(cached.binding.inputHash).toBe(binding().inputHash);
});
it('keeps ambiguous effects unresolved across new IDs, changed target/body/provider and another managed effect', async () => {
  const { database, store } = fixture(); let effects = 0;
  await expect(new DecisionRunner(store).run(options(() => { effects++; throw Error('owned effect may have applied'); }))).rejects.toThrow();
  expect((await new DecisionRunner(store).run(options(() => { effects++; return null; }))).status).toBe('needs-owner');
  await expect(new DecisionRunner(store).run({ ...options(() => { effects++; return null; }), id: 'new-id' })).rejects.toThrow();
  for (const operation of [{ ...association.operation, targetDigest: 'd'.repeat(64) }, { ...association.operation, contentDigest: 'e'.repeat(64) }, { ...association.operation, provider: 'other' }]) {
    await expect(new DecisionRunner(new LogDecisionStore({ database, association: { ...association, operation } })).run(options(() => null))).rejects.toThrow();
  }
  const other = new LogDecisionStore({ database, association: { ...association, effectKey: 'other-effect', stepId: 'handoff' } });
  await expect(new DecisionRunner(other).run({ ...options(() => { effects++; return null; }), id: 'handoff' })).rejects.toThrow(); expect(effects).toBe(1);
});
it('retains exclusive decision ownership until a real callback drains after cancellation', async () => {
  const { store, database } = fixture(); const controller = new AbortController(); let finish!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const run = new DecisionRunner(store).run({ ...options(() => null), signal: controller.signal, execute: async () => { entered(); await held; return null; } });
  await started; controller.abort();
  await expect(new DecisionRunner(new LogDecisionStore({ database, association })).run(options(() => null))).rejects.toThrow();
  expect(database.inspectOwnership('decision', identity)).toBeDefined(); finish(); await expect(run).rejects.toThrow();
  expect(database.inspectOwnership('decision', identity)).toBeUndefined();
});
it('rejects runtime opt-out from managed unresolved-effect guards', () => {
  const { database } = fixture(); expect(() => new LogDecisionStore({ database, association, requireResolvedRun: false as never })).toThrow();
});
