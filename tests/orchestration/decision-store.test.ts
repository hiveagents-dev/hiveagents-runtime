import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileWorkflowStore } from '../../src/orchestration/workflow/file-store.js';
import { bindDecision, DecisionRunner, WorkflowDecisionStore } from '../../src/orchestration/decisions/index.js';

it('persists waits in existing workflow stores and recovers with a new decision runner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-decision-'));
  try {
    const binding = bindDecision({ input: { document: 'one' }, authority: 'local-only', inputVersion: '1', authorityVersion: '1' });
    let allowed = false, effects = 0;
    const options = { id: 'one', binding, isCurrent: () => true,
      authorize: () => ({ decision: allowed ? 'allow' as const : 'wait' as const, reason: 'operator check', expiresAt: Date.now() + 10_000 }),
      execute: () => { effects++; return { report: 'local artifact' }; },
      verify: () => ({ verified: true, evidence: ['artifact:one'] }) };
    const store = () => new WorkflowDecisionStore(new FileWorkflowStore(directory));
    expect((await new DecisionRunner(store()).run(options)).status).toBe('waiting');
    allowed = true;
    expect((await new DecisionRunner(store()).run(options)).status).toBe('verified');
    expect((await new DecisionRunner(store()).run(options)).status).toBe('verified');
    expect(effects).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
