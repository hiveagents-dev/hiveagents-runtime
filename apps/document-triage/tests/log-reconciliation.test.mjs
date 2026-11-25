import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bindDecision, DecisionRunner } from 'hiveagents-runtime/orchestration';
import { LogExecutionDatabase, LogDecisionStore, inspectManagedEffect } from 'hiveagents-runtime/orchestration/log';

test('public reconciliation verifies original file evidence and resolves the original needs-owner intent without dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'triage-log-reconcile-')), target = join(directory, 'original-report.json');
  const digest = text => createHash('sha256').update(text).digest('hex'), bytes = JSON.stringify({ report: 'original-owned-result' });
  const identity = { systemId: 'document-triage', generation: 1, runId: 'owned-run', agentId: 'local-triage', harness: { id: 'local-rules', version: '1', digest: digest('local-rules:1') } };
  const association = { identity, stepId: 'report', effectKey: 'owned-report', operation: { id: 'write-report', version: '1', targetDigest: digest(target), contentDigest: digest(bytes) } };
  const database = new LogExecutionDatabase({ databasePath: join(directory, 'execution.sqlite'), systemId: identity.systemId });
  try {
    const store = new LogDecisionStore({ database, association }); let dispatches = 0;
    const options = { id: 'original-decision', binding: bindDecision({ input: { targetDigest: digest(target), contentDigest: digest(bytes) }, authority: { id: 'local-owner' }, inputVersion: '1', authorityVersion: '1' }),
      authorize: () => ({ decision: 'allow', reason: 'owned fixture', expiresAt: Date.now() + 30000 }), isCurrent: () => true,
      async execute() { dispatches++; const file = await open(target, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } throw Error('owned interruption after effect'); },
      verify: () => ({ verified: false, evidence: [] }) };
    await assert.rejects(new DecisionRunner(store).run(options));
    const original = inspectManagedEffect(database, association).record; assert.equal(original.status, 'needs-owner'); assert.equal(await readFile(target, 'utf8'), bytes);
    assert.equal((await new DecisionRunner(store).run({ ...options, execute() { throw Error('must not redispatch'); }, verify: () => ({ verified: true, evidence: [`file:${digest(bytes)}`] }) })).status, 'needs-owner');
    assert.equal(typeof store.reconcile, 'function', 'SDK lacks public original-intent reconciliation despite exact original-target evidence');
    const reconciled = await store.reconcile({ id: options.id, intentId: original.intentId, binding: original.binding,
      async verifyApplied(context) {
        assert.equal(context.association.operation.targetDigest, digest(target)); assert.equal(context.record.intentId, original.intentId);
        const actual = await readFile(target, 'utf8');
        return { verified: digest(actual) === association.operation.contentDigest, result: { reportDigest: digest(actual) }, evidence: [`owned-file:${digest(actual)}`] };
      } });
    assert.equal(reconciled.status, 'verified'); assert.equal(reconciled.intentId, original.intentId); assert.equal(reconciled.attempts, original.attempts); assert.equal(dispatches, 1);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});
