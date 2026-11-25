import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWorkflowStore, WorkflowRunner, type WorkflowCheckpoint, type WorkflowDefinition, type WorkflowStep, type WorkflowStore,
} from '../../src/orchestration/workflow/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-persistence-')); directories.push(directory);
  return { directory, store: new FileWorkflowStore(directory) };
}
const definition = (steps: readonly WorkflowStep[]): WorkflowDefinition => ({ id: 'persistence', version: '1', steps });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Condition did not become true');
}
const shape = (checkpoint: WorkflowCheckpoint) => `${checkpoint.status}:${Object.values(checkpoint.steps).map(step => step.status).join(',')}`;
function recording(store: WorkflowStore, saves: string[]): WorkflowStore {
  return { async acquire(runId) {
    const lease = await store.acquire(runId);
    return { ...lease, save(checkpoint) { saves.push(shape(checkpoint)); return lease.save(checkpoint); } };
  } };
}

describe('checkpoint writes', () => {
  it('re-reads a completed checkpoint without writing and never repeats an unchanged running snapshot', async () => {
    const { store } = await fixture(); const saves: string[] = [];
    const workflow = definition([{ id: 'a', execute: () => 'a' }, { id: 'b', dependencies: ['a'], execute: () => 'b' }]);
    await new WorkflowRunner(recording(store, saves)).run(workflow, { runId: 'once', concurrency: 1 });
    expect(saves).toEqual([
      'running:pending,pending', 'running:running,pending', 'running:completed,pending',
      'running:completed,running', 'running:completed,completed', 'completed:completed,completed',
    ]);
    saves.length = 0;
    const again = await new WorkflowRunner(recording(store, saves)).run(workflow, { runId: 'once' });
    expect(again).toMatchObject({ status: 'completed', steps: { a: { output: 'a' }, b: { output: 'b' } } });
    expect(saves).toEqual([]);
  });

  it('still records a blocked dependant in the wave snapshot', async () => {
    const { store } = await fixture(); const saves: string[] = [];
    const result = await new WorkflowRunner(recording(store, saves)).run(definition([
      { id: 'a', execute() { throw new Error('no'); } }, { id: 'b', dependencies: ['a'], execute: () => 'b' },
    ]), { runId: 'blocked' });
    expect(result.steps.b?.status).toBe('blocked');
    expect(saves.at(-2)).toBe('running:failed,blocked');
  });

  it('groups persist requests made while a write is in flight into one later snapshot, never starting a callback early', async () => {
    const { store } = await fixture(); const gate = deferred(); const snapshots: WorkflowCheckpoint[] = [];
    let blocked = false;
    const slow: WorkflowStore = { async acquire(runId) {
      const lease = await store.acquire(runId);
      return { ...lease, async save(checkpoint) {
        snapshots.push(JSON.parse(JSON.stringify(checkpoint)) as WorkflowCheckpoint);
        if (checkpoint.steps.a?.status === 'running' && !blocked) { blocked = true; await gate.promise; }
        await lease.save(checkpoint);
      } };
    } };
    const started: string[] = [];
    const run = new WorkflowRunner(slow).run(definition(['a', 'b', 'c', 'd'].map(id => ({
      id, execute() { started.push(id); return id; },
    }))), { runId: 'group', concurrency: 4 });
    await until(() => blocked);
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    // Three workers consumed their attempts and are waiting on ONE grouped write; none has run yet.
    expect(started).toEqual([]);
    expect(snapshots).toHaveLength(2);
    gate.resolve();
    const result = await run;
    expect(result.status).toBe('completed'); expect(started.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(Object.values(snapshots[1]!.steps).every(step => step.status === 'running' && step.attempts === 1)).toBe(true);
    // Fewer disk writes than requests: 1 start + 1 (a running) + 1 (b,c,d running) + completions + final.
    expect(snapshots.length).toBeLessThan(10);
  });
});
