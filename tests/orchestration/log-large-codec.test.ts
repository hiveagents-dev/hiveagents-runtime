import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { LogWorkflowStore } from '../../src/orchestration/log/workflow-store.js';
import { createLogArtifactStore } from '../../src/orchestration/log/artifacts.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { bindDecision, decisionHash } from '../../src/orchestration/decisions/binding.js';
import { WorkflowRunner } from '../../src/orchestration/workflow/runner.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
import type { LogArtifactWriteOptions, LogArtifactReadOptions } from '../../src/orchestration/log/artifacts-types.js';
import type { PayloadReference } from '../../src/orchestration/log/types.js';
import { largeReader } from './log-large-process.js';
const cleanup: (() => void)[] = [];
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const identity = logDraft().identity;
const association = { identity, stepId: 'effect', effectKey: 'large', operation: { id: 'owned', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
async function fixture() {
  const files = logDirectory(); cleanup.push(files.cleanup); let artifacts!: Awaited<ReturnType<typeof createLogArtifactStore>>;
  const artifactStore = {
    write: (input: string | Uint8Array, options: LogArtifactWriteOptions) => artifacts.write(input, options),
    read: (reference: PayloadReference, options?: LogArtifactReadOptions) => artifacts.read(reference, options),
    verify: (reference: PayloadReference, options?: LogArtifactReadOptions) => artifacts.verify(reference, options),
  };
  const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture', artifactStore, maxRecordBytes: 64 * 1024 * 1024 }); cleanup.push(() => database.close());
  const artifactDirectory = join(realpathSync(files.directory), 'artifacts');
  artifacts = await createLogArtifactStore({ directory: artifactDirectory, binding: { sourceId: database.sourceId, systemId: 'fixture', generation: 1 } });
  return { ...files, database, artifacts, artifactStore, artifactDirectory };
}
it('actual DecisionRunner saves and rehydrates a 20MiB Unicode result with original legacy hashes and no redispatch', async () => {
  const { database, file, artifactStore, artifactDirectory, directory } = await fixture(), text = '😀'.repeat(5 * 1024 * 1024) + '\r\ná', result = { z: { text }, a: ['kept', 42] }, counter = join(directory, 'effects.count'); let effects = 0;
  const options = { id: 'large-decision', binding: bindDecision({ input: { z: 'first', a: 'second' }, authority: null, inputVersion: '1', authorityVersion: '1' }),
    authorize: () => ({ decision: 'allow' as const, reason: 'owned', expiresAt: Date.now() + 30000 }), isCurrent: () => true,
    execute: () => { effects++; appendFileSync(counter, 'once\n'); return result; }, verify: () => ({ verified: true, evidence: ['owned:large:digest'] }) };
  const first = await new DecisionRunner(new LogDecisionStore({ database, association })).run(options); expect(first.status).toBe('verified'); expect(first.receipt!.resultHash).toBe(decisionHash(result));
  const events = (await database.readPage({ limit: 256 })).items;
  expect(events.some(event => event.record.schema.id === 'oar.execution.body' && 'artifact' in event.record.payload)).toBe(true);
  expect(events.some(event => event.record.schema.id === 'oar.execution.decision' && event.record.schema.version === 2)).toBe(true);
  database.close();
  const fresh = await largeReader(directory, file, artifactDirectory, counter, 'decision'); expect(fresh).toEqual({ status: 'verified', digest: first.receipt!.resultHash, intentId: first.intentId }); expect(readFileSync(counter, 'utf8')).toBe('once\n');
  const reopened = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture', artifactStore, maxRecordBytes: 64 * 1024 * 1024 }); cleanup.push(() => reopened.close());
  const cached = await new DecisionRunner(new LogDecisionStore({ database: reopened, association })).run(options);
  expect(cached.receipt).toEqual(first.receipt); expect(textHash((cached.result as typeof result).z.text)).toBe(textHash(text)); expect(effects).toBe(1);
}, 60000);
it('actual WorkflowRunner reopens a 32MiB checkpoint without repeating its callback', async () => {
  const { database, file, artifactStore, artifactDirectory, directory } = await fixture(), text = 'á'.repeat(16 * 1024 * 1024), counter = join(directory, 'effects.count'); let effects = 0;
  const definition = { id: 'large-workflow', version: '1', steps: [{ id: 'effect', execute: () => { effects++; appendFileSync(counter, 'once\n'); return { z: { text }, a: 'last' }; } }] };
  const first = await new WorkflowRunner(new LogWorkflowStore({ database, identity, definition })).run(definition, { runId: identity.runId }); expect(first.status).toBe('completed'); database.close();
  const fresh = await largeReader(directory, file, artifactDirectory, counter, 'workflow'); expect(fresh).toEqual({ status: 'completed', digest: decisionHash(first.steps.effect!.output!) }); expect(readFileSync(counter, 'utf8')).toBe('once\n');
  const reopened = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture', artifactStore, maxRecordBytes: 64 * 1024 * 1024 }); cleanup.push(() => reopened.close());
  const cached = await new WorkflowRunner(new LogWorkflowStore({ database: reopened, identity, definition })).run(definition, { runId: identity.runId });
  expect(textHash((cached.steps.effect!.output as { z: { text: string } }).z.text)).toBe(textHash(text)); expect(effects).toBe(1);
}, 60000);
