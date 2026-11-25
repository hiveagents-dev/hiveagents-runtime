import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWorkflowStore, WorkflowRunner, type WorkflowCheckpoint, type WorkflowRunOptions,
  type WorkflowStore,
} from '../../src/orchestration/workflow/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-failure-')); directories.push(directory);
  return { directory, store: new FileWorkflowStore(directory) };
}
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

describe('workflow failure boundaries', () => {
  it('drains active callbacks after a checkpoint failure, aborts them and starts no queued work', async () => {
    const { store } = await fixture(); let saveFailed = false;
    const first = deferred(); const second = deferred(); let active = 0; let calls = 0; let observedAbort = false;
    const failing: WorkflowStore = { async acquire(runId) {
      const lease = await store.acquire(runId);
      return { ...lease, async save(checkpoint) {
        if (checkpoint.steps.a?.status === 'completed') { saveFailed = true; throw new Error('disk unavailable'); }
        await lease.save(checkpoint);
      } };
    } };
    const run = new WorkflowRunner(failing).run({ id: 'disk', version: '1', steps: [
      { id: 'a', async execute() { active++; calls++; await first.promise; active--; return 'a'; } },
      { id: 'b', async execute({ signal }) { active++; calls++; await second.promise; observedAbort = signal.aborted; active--; return 'b'; } },
      { id: 'queued', execute() { calls++; return 'should not run'; } },
    ] }, { runId: 'disk', concurrency: 2 });
    let ended = false;
    const caught = run.catch(error => { ended = true; return error; });
    await until(() => calls === 2); first.resolve();
    await until(() => saveFailed);
    expect(ended).toBe(false); expect(active).toBe(1);
    second.resolve();
    expect(await caught).toMatchObject({ message: 'disk unavailable' });
    expect(active).toBe(0); expect(calls).toBe(2); expect(observedAbort).toBe(true);
    expect(await store.inspectOwnership('disk')).toBeUndefined();
  });

  it('does not write further queued snapshots after the store has failed', async () => {
    const { store } = await fixture(); const blockedSave = deferred(); let savingRunning = false; let savesAfterFailure = 0;
    let failed = false; let calls = 0;
    const failing: WorkflowStore = { async acquire(runId) {
      const lease = await store.acquire(runId);
      return { ...lease, async save(checkpoint) {
        if (failed) { savesAfterFailure++; return lease.save(checkpoint); }
        if (checkpoint.steps.a?.status === 'running') {
          savingRunning = true; await blockedSave.promise; failed = true; throw new Error('disk stopped');
        }
        await lease.save(checkpoint);
      } };
    } };
    const run = new WorkflowRunner(failing).run({ id: 'writes', version: '1', steps: ['a', 'b'].map(id => ({
      id, execute() { calls++; return null; },
    })) }, { runId: 'writes', concurrency: 2 });
    const caught = run.catch(error => error);
    await until(() => savingRunning); blockedSave.resolve();
    expect(await caught).toMatchObject({ message: 'disk stopped' });
    expect(calls).toBe(0); expect(savesAfterFailure).toBe(0);
  });

  it('snapshots the run identity so caller mutation cannot change later idempotency keys', async () => {
    const { store } = await fixture(); const seen: string[] = [];
    const options: WorkflowRunOptions = { runId: 'original', concurrency: 1 };
    await new WorkflowRunner(store).run({ id: 'identity', version: '1', steps: [
      { id: 'a', execute({ runId }) { seen.push(runId); options.runId = 'changed'; return 'a'; } },
      { id: 'b', execute({ runId }) { seen.push(runId); return 'b'; } },
    ] }, options);
    expect(seen).toEqual(['original', 'original']);
  });

  it.each(['negative attempts', 'lost output', 'premature child', 'invented step', 'invalid terminal', 'array run status', 'array step status'])('rejects structurally corrupt state even with a matching checksum: %s', async corruption => {
    const { store, directory } = await fixture(); let calls = 0;
    const workflow = { id: 'schema', version: '1', steps: [
      { id: 'a', execute() { calls++; return 'a'; } },
      { id: 'b', dependencies: ['a'], execute() { calls++; return 'b'; } },
    ] };
    const runner = new WorkflowRunner(store); await runner.run(workflow, { runId: 'schema' });
    const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { checkpoint: WorkflowCheckpoint; checksum: string };
    const checkpoint = envelope.checkpoint;
    if (corruption === 'negative attempts') checkpoint.steps.a!.attempts = -1;
    if (corruption === 'lost output') delete checkpoint.steps.a!.output;
    if (corruption === 'premature child') checkpoint.steps.a = { status: 'pending', attempts: 0 };
    if (corruption === 'invented step') checkpoint.steps.extra = { status: 'pending', attempts: 0 };
    if (corruption === 'invalid terminal') checkpoint.status = 'failed';
    if (corruption === 'array run status') checkpoint.status = ['completed'] as never;
    if (corruption === 'array step status') {
      checkpoint.status = 'running'; checkpoint.steps.b!.status = ['running'] as never; delete checkpoint.steps.b!.output;
    }
    envelope.checksum = createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
    await writeFile(file, JSON.stringify(envelope));
    await expect(runner.run(workflow, { runId: 'schema' })).rejects.toThrow(/corrupt/i);
    expect(calls).toBe(2);
  });

  it('passes isolated dependency values so callbacks cannot rewrite a completed checkpoint', async () => {
    const { store } = await fixture();
    const result = await new WorkflowRunner(store).run({ id: 'isolated', version: '1', steps: [
      { id: 'a', execute: () => ({ value: 'original' }) },
      { id: 'b', dependencies: ['a'], execute({ dependencyOutputs }) {
        (dependencyOutputs.a as { value: string }).value = 'mutated'; return null;
      } },
      { id: 'c', dependencies: ['a', 'b'], execute: ({ dependencyOutputs }) => dependencyOutputs.a! },
    ] }, { runId: 'isolated' });
    expect(result.steps.a?.output).toEqual({ value: 'original' });
    expect(result.steps.c?.output).toEqual({ value: 'original' });
  });
});

it('releases run ownership when an AbortSignal listener registration throws', async () => {
  const { store } = await fixture(); const abort = new AbortController();
  Object.defineProperty(abort.signal, 'addEventListener', { value() { throw new Error('listener failed'); } });
  await expect(new WorkflowRunner(store).run({ id: 'signal', version: '1', steps: [] }, {
    runId: 'signal', signal: abort.signal,
  })).rejects.toThrow('listener failed');
  expect(await store.inspectOwnership('signal')).toBeUndefined();
});

it('rejects an invalid JavaScript signal before acquiring a run', async () => {
  const { store } = await fixture();
  await expect(new WorkflowRunner(store).run({ id: 'signal', version: '1', steps: [] }, {
    runId: 'invalid-signal', signal: {} as AbortSignal,
  })).rejects.toThrow(/signal/i);
  expect(await store.inspectOwnership('invalid-signal')).toBeUndefined();
});

it('records arbitrary thrown values as failures and blocks their dependencies', async () => {
  const { store } = await fixture(); let child = 0;
  const result = await new WorkflowRunner(store).run({ id: 'thrown', version: '1', steps: [
    { id: 'a', execute() { throw Object.create(null); } },
    { id: 'b', dependencies: ['a'], execute() { child++; return null; } },
  ] }, { runId: 'thrown' });
  expect(result.status).toBe('failed'); expect(result.steps.a?.error).toMatch(/callback failed/i);
  expect(result.steps.b?.status).toBe('blocked'); expect(child).toBe(0);
});
