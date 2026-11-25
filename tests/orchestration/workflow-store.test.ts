import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileWorkflowStore, WorkflowRunner, type WorkflowCheckpoint } from '../../src/orchestration/workflow/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('finishes an already-submitted checkpoint before releasing ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-store-')); directories.push(directory);
  const store = new FileWorkflowStore(directory);
  await new WorkflowRunner(store).run({ id: 'store', version: '1', steps: [{ id: 'task', execute: () => 1 }] }, { runId: 'store' });
  const lease = await store.acquire('store');
  const checkpoint = await lease.load() as WorkflowCheckpoint;
  checkpoint.steps.task!.output = 'x'.repeat(1_000_000);
  const saving = lease.save(checkpoint);
  const releasing = lease.release();
  await expect(Promise.all([saving, releasing])).resolves.toEqual([undefined, undefined]);
  const next = await store.acquire('store');
  expect((await next.load() as WorkflowCheckpoint).steps.task?.output).toHaveLength(1_000_000);
  await expect(lease.save(checkpoint)).rejects.toThrow(/ownership/i);
  await next.release();
});
