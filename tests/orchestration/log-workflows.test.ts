import { afterEach, expect, it } from 'vitest';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { LogWorkflowStore } from '../../src/orchestration/log/workflow-store.js';
import { inspectManagedEffect } from '../../src/orchestration/log/effects.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import { WorkflowRunner } from '../../src/orchestration/workflow/runner.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
import type { WorkflowDefinition } from '../../src/orchestration/workflow/types.js';
const identity = logDraft().identity;
const association = { identity, stepId: 'effect', effectKey: 'stable', operation: { id: 'owned-local-file', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const files = logDirectory(); cleanup.push(files.cleanup); const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' }); cleanup.push(() => database.close()); return { ...files, database }; }
it('runs actual workflow callbacks using managed DecisionRunner and atomically persists both store views', async () => {
  const { database, file } = fixture(); let calls = 0;
  const decisions = new LogDecisionStore({ database, association });
  const definition: WorkflowDefinition = { id: 'workflow', version: '1', steps: [{ id: 'effect', execute: async () => {
    const result = await new DecisionRunner(decisions).run({ id: 'decision', binding: bindDecision({ input: { owned: 'file' }, authority: null, inputVersion: '1', authorityVersion: '1' }),
      authorize: () => ({ decision: 'allow', reason: 'fixture', expiresAt: Date.now() + 10000 }), isCurrent: () => true,
      execute: () => { calls++; return { file: 'written' }; }, verify: () => ({ verified: true, evidence: ['owned:file:digest'] }) }); return result.result!;
  } }] };
  const store = new LogWorkflowStore({ database, identity, definition });
  expect((await new WorkflowRunner(store).run(definition, { runId: identity.runId })).status).toBe('completed');
  expect(inspectManagedEffect(database, association)?.record?.status).toBe('verified'); database.close();
  const reopened = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => reopened.close());
  const recovered = new LogWorkflowStore({ database: reopened, identity, definition });
  expect((await new WorkflowRunner(recovered).run(definition, { runId: identity.runId })).status).toBe('completed'); expect(calls).toBe(1);
});
it('unresolved managed effects block replaySafe and manual rearm while retaining child facts for inspection', async () => {
  const { database } = fixture(); let effects = 0;
  const decisions = new LogDecisionStore({ database, association });
  const definition: WorkflowDefinition = { id: 'workflow', version: '1', steps: [{ id: 'effect', replaySafe: true, maxAttempts: 3, execute: async () => {
    await new DecisionRunner(decisions).run({ id: 'decision', binding: bindDecision({ input: null, authority: null, inputVersion: '1', authorityVersion: '1' }),
      authorize: () => ({ decision: 'allow', reason: 'fixture', expiresAt: Date.now() + 10000 }), isCurrent: () => true,
      execute: () => { effects++; throw Error('effect uncertainty'); }, verify: () => ({ verified: false, evidence: [] }) }); return null;
  } }] };
  const store = new LogWorkflowStore({ database, identity, definition }), runner = new WorkflowRunner(store);
  await expect(runner.run(definition, { runId: identity.runId })).rejects.toThrow();
  const firstOwner = database.inspectOwnership('workflow', identity); if (firstOwner) database.recoverAbandoned(firstOwner, { ownerStopped: true });
  await expect(runner.run(definition, { runId: identity.runId, recoverInterrupted: 'replay-safe' })).rejects.toThrow();
  const secondOwner = database.inspectOwnership('workflow', identity); if (secondOwner) database.recoverAbandoned(secondOwner, { ownerStopped: true });
  await expect(runner.rearm(definition, { runId: identity.runId, steps: 'incomplete', acknowledgement: { workStopped: true } })).rejects.toThrow();
  expect(inspectManagedEffect(database, association)?.record?.status).toBe('needs-owner'); expect(effects).toBe(1);
});
