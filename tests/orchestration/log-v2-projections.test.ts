import { afterEach, expect, it } from 'vitest';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { WorkflowRunner } from '../../src/orchestration/workflow/runner.js';
import { LogWorkflowStore } from '../../src/orchestration/log/workflow-store.js';
import { createLogAuditProjector } from '../../src/orchestration/log/audit-projector.js';
import { largeFixture, largeIdentity, largeOptions } from './log-large-fixture.js';
const cleanup: Array<() => unknown> = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('projects committed DecisionRunner v2 metadata without opening its real private record body', async () => {
  let reads = 0, verifies = 0, effects = 0;
  const fixture = await largeFixture({ read: () => { reads++; }, verify: () => { verifies++; } }); cleanup.push(fixture.cleanup); cleanup.push(() => fixture.database.close());
  await new DecisionRunner(fixture.store).run(largeOptions(() => { effects++; return { text: `seeded-private-body-${'😀'.repeat(24000)}` }; }));
  const before = { reads, verifies }, view = await createLogAuditProjector({ reader: fixture.database, identity: largeIdentity }).rebuild();
  expect(view.items.some(item => item.category === 'decision' && (item.metadata as { status: string }).status === 'verified')).toBe(true);
  expect(view.kind).toBe('incomplete'); expect(view.issues).toContain('PRIVATE_PAYLOAD'); expect(view.issues).not.toContain('UNKNOWN_SCHEMA');
  expect({ reads, verifies }).toEqual(before); expect(effects).toBe(1); expect(JSON.stringify(view)).not.toContain('seeded-private-body');
});
it('projects actual WorkflowRunner v2 status and step hashes while keeping checkpoints private', async () => {
  let effects = 0, reads = 0, verifies = 0;
  const fixture = await largeFixture({ read: () => { reads++; }, verify: () => { verifies++; } }); cleanup.push(fixture.cleanup); cleanup.push(() => fixture.database.close());
  const definition = { id: 'owned-workflow', version: '1', steps: [{ id: 'owned-step', execute: () => { effects++; return { text: `seeded-checkpoint-${'á'.repeat(48000)}` }; } }] };
  await new WorkflowRunner(new LogWorkflowStore({ database: fixture.database, identity: largeIdentity, definition })).run(definition, { runId: largeIdentity.runId });
  const before = { reads, verifies }, view = await createLogAuditProjector({ reader: fixture.database, identity: largeIdentity }).rebuild();
  expect(view.items.some(item => item.category === 'workflow' && (item.metadata as { status: string }).status === 'completed')).toBe(true);
  expect(view.kind).toBe('incomplete'); expect(view.issues).toContain('PRIVATE_PAYLOAD'); expect(view.issues).not.toContain('UNKNOWN_SCHEMA');
  expect({ reads, verifies }).toEqual(before); expect(effects).toBe(1); expect(JSON.stringify(view)).not.toContain('seeded-checkpoint');
});
