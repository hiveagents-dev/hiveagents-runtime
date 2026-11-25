import { appendFileSync } from 'node:fs';
import { LogExecutionDatabase } from '../../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../../src/orchestration/log/decision-store.js';
import { LogWorkflowStore } from '../../../src/orchestration/log/workflow-store.js';
import { createLogArtifactStore } from '../../../src/orchestration/log/artifacts.js';
import { DecisionRunner } from '../../../src/orchestration/decisions/runner.js';
import { decisionHash } from '../../../src/orchestration/decisions/binding.js';
import { WorkflowRunner } from '../../../src/orchestration/workflow/runner.js';
import { largeAssociation, largeIdentity, largeOptions } from '../log-large-fixture.js';
const [file, directory, counter, mode] = process.argv.slice(2); if (!file || !directory || !counter) throw Error('owned reader arguments missing');
let artifacts!: Awaited<ReturnType<typeof createLogArtifactStore>>;
const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture', maxRecordBytes: 64 * 1024 * 1024, artifactStore: {
  write: (input, options) => artifacts.write(input, options), read: (ref, options) => artifacts.read(ref, options), verify: (ref, options) => artifacts.verify(ref, options),
} });
artifacts = await createLogArtifactStore({ directory, binding: { sourceId: database.sourceId, systemId: 'fixture', generation: 1 } });
const unexpected = () => { appendFileSync(counter, 'duplicate\n'); throw Error('fixture must not redispatch'); };
try {
  if (mode === 'workflow') {
    const definition = { id: 'large-workflow', version: '1', steps: [{ id: 'effect', execute: unexpected }] };
    const checkpoint = await new WorkflowRunner(new LogWorkflowStore({ database, identity: largeIdentity, definition })).run(definition, { runId: largeIdentity.runId });
    process.stdout.write(JSON.stringify({ status: checkpoint.status, digest: decisionHash(checkpoint.steps.effect!.output!) }));
  } else {
    const result = await new DecisionRunner(new LogDecisionStore({ database, association: largeAssociation })).run(largeOptions(unexpected));
    process.stdout.write(JSON.stringify({ status: result.status, digest: result.receipt?.resultHash, intentId: result.intentId }));
  }
} finally { database.close(); }
