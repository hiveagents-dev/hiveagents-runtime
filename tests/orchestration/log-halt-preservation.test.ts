import { afterEach, expect, it } from 'vitest';
import { ExecutionHaltedError, isExecutionHalted } from '../../src/public/execution-halt.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import { WorkflowRunner } from '../../src/orchestration/workflow/runner.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { LogWorkflowStore } from '../../src/orchestration/log/workflow-store.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
import type { DecisionStore } from '../../src/orchestration/decisions/types.js';
import type { WorkflowDefinition, WorkflowStore } from '../../src/orchestration/workflow/types.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const identity = logDraft().identity;
function fixture() { const files = logDirectory(); cleanup.push(files.cleanup); const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => database.close()); return database; }
function contains(error: unknown, original: unknown): boolean {
  if (error === original) return true; if (!(error instanceof Error)) return false;
  return contains(error.cause, original) || error instanceof AggregateError && error.errors.some(item => contains(item, original));
}
const binding = () => bindDecision({ input: null, authority: null, inputVersion: '1', authorityVersion: '1' });
it('actual DecisionRunner retains the original nominal halt graph when needs-owner accounting and release also fail', async () => {
  const database = fixture(), actual = new LogDecisionStore({ database, association: { identity, stepId: 'effect', effectKey: 'effect', operation: { id: 'owned', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } } });
  const original = new AggregateError([new ExecutionHaltedError({ observedUsage: { inputTokens: 7, costMeaning: 'unavailable' } })], 'original-aggregate');
  const wrapped: DecisionStore = { async acquire(id) { const lease = await actual.acquire(id); return { ...lease,
    async save(record) { if (record.status === 'needs-owner') throw Error('accounting-secondary'); await lease.save(record); },
    async release() { await lease.release(); throw Error('release-secondary'); },
  }; } };
  let failure: unknown;
  try { await new DecisionRunner(wrapped).run({ id: 'decision', binding: binding(), authorize: () => ({ decision: 'allow', reason: 'fixture', expiresAt: Date.now() + 10000 }), isCurrent: () => true, execute: () => { throw original; }, verify: () => ({ verified: false, evidence: [] }) }); } catch (error) { failure = error; }
  expect(contains(failure, original)).toBe(true); expect(isExecutionHalted(failure)).toBe(true);
});
it('actual WorkflowRunner does not retry a genuine halt or discard it when persistence/release fail', async () => {
  const database = fixture(), original = new AggregateError([new ExecutionHaltedError()], 'original-workflow-halt'); let calls = 0;
  const definition: WorkflowDefinition = { id: 'workflow', version: '1', steps: [{ id: 'effect', maxAttempts: 3, execute: () => { calls++; throw original; } }] };
  const actual = new LogWorkflowStore({ database, identity, definition });
  const wrapped: WorkflowStore = { async acquire(id) { const lease = await actual.acquire(id); return { ...lease,
    async save(checkpoint) { if (checkpoint.steps.effect?.status === 'interrupted') throw Error('persistence-secondary'); await lease.save(checkpoint); },
    async release() { await lease.release(); throw Error('release-secondary'); },
  }; } };
  let failure: unknown; try { await new WorkflowRunner(wrapped).run(definition, { runId: identity.runId }); } catch (error) { failure = error; }
  expect(calls).toBe(1); expect(contains(failure, original)).toBe(true); expect(isExecutionHalted(failure)).toBe(true);
});
it('refuses a backwards clock across real asynchronous authorization before dispatch', async () => {
  const database = fixture(), store = new LogDecisionStore({ database, association: { identity, stepId: 'effect', effectKey: 'clock', operation: { id: 'owned', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } } });
  let clock = 100, effects = 0, failure: unknown;
  try { await new DecisionRunner(store).run({ id: 'clock', binding: binding(), now: () => clock,
    authorize: async () => { clock = 50; return { decision: 'allow', reason: 'fixture', expiresAt: 200 }; }, isCurrent: () => true,
    execute: () => { effects++; return null; }, verify: () => ({ verified: true, evidence: ['owned'] }) }); } catch (error) { failure = error; }
  expect(effects).toBe(0); expect(isExecutionHalted(failure)).toBe(true);
});
