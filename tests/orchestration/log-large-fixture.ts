import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { LogExecutionDatabase, executionContext } from '../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { createLogArtifactStore } from '../../src/orchestration/log/artifacts.js';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
import type { ExecutionArtifactStore } from '../../src/orchestration/log/execution-types.js';
export const largeIdentity = logDraft().identity;
export const largeAssociation = { identity: largeIdentity, stepId: 'effect', effectKey: 'large', operation: { id: 'owned', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
export const largeBinding = () => bindDecision({ input: { z: 'first', a: 'second' }, authority: null, inputVersion: '1', authorityVersion: '1' });
export async function largeFixture(hooks: Partial<Record<'write' | 'read' | 'verify', () => void | Promise<void>>> = {}, maxRecordBytes = 64 * 1024 * 1024) {
  const files = logDirectory(), directory = join(realpathSync(files.directory), 'artifacts'); let artifacts!: Awaited<ReturnType<typeof createLogArtifactStore>>;
  let observed: LogExecutionDatabase | undefined;
  const modes: boolean[] = [];
  const artifactStore: ExecutionArtifactStore = {
    async write(input, options) { modes.push(executionContext(observed!).db.isTransaction); await hooks.write?.(); return artifacts.write(input, options); },
    async read(reference, options) { modes.push(executionContext(observed!).db.isTransaction); await hooks.read?.(); return artifacts.read(reference, options); },
    async verify(reference, options) { modes.push(executionContext(observed!).db.isTransaction); await hooks.verify?.(); return artifacts.verify(reference, options); },
  };
  const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture', artifactStore, maxRecordBytes });
  observed = database;
  artifacts = await createLogArtifactStore({ directory, binding: { sourceId: database.sourceId, systemId: 'fixture', generation: 1 } });
  return { ...files, database, directory, artifacts, artifactStore, modes, observe: (next: LogExecutionDatabase) => { observed = next; }, store: new LogDecisionStore({ database, association: largeAssociation }) };
}
export function largeOptions(execute: () => any) {
  return { id: 'large-decision', binding: largeBinding(), authorize: () => ({ decision: 'allow' as const, reason: 'owned', expiresAt: Date.now() + 30000 }), isCurrent: () => true, execute, verify: () => ({ verified: true, evidence: ['owned:large:digest'] }) };
}
