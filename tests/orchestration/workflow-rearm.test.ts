import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWorkflowStore, WorkflowRunner, WorkflowRunLockedError, type WorkflowDefinition, type WorkflowStep, type WorkflowStore,
} from '../../src/orchestration/workflow/index.js';
import { identity } from '../../src/orchestration/workflow/checkpoint.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-rearm-')); directories.push(directory);
  return { directory, store: new FileWorkflowStore(directory) };
}
const definition = (steps: readonly WorkflowStep[]): WorkflowDefinition => ({ id: 'grow-weekly', version: 'v', steps });
const acknowledgement = { workStopped: true } as const;
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
/** The app's configuration: one attempt, replay-safe, a guard at entry (electron/workflows.ts). */
function appWorkflow(abort: AbortController, calls: Array<[string, number]>, keys: string[]) {
  let first = true;
  return definition([
    { id: 'signals', maxAttempts: 1, replaySafe: true, execute({ attempt }) { calls.push(['signals', attempt]); return 'ready'; } },
    { id: 'accounts', dependencies: ['signals'], maxAttempts: 1, replaySafe: true, async execute({ attempt, idempotencyKey, signal }) {
      calls.push(['accounts', attempt]); keys.push(idempotencyKey);
      if (first) { first = false; abort.abort(); signal.throwIfAborted(); }
      return 'done';
    } },
  ]);
}

describe('WorkflowRunner.rearm', () => {
  it('re-arms the steps a cooperative cancellation consumed, under the lease, so the app stops editing checkpoints', async () => {
    const { store } = await fixture(); const abort = new AbortController(); const calls: Array<[string, number]> = []; const keys: string[] = [];
    const workflow = appWorkflow(abort, calls, keys);
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'r', signal: abort.signal, recoverInterrupted: 'replay-safe' })).status).toBe('cancelled');
    // Without a re-arm the consumed attempt makes the resume fail: the pinned guarantee.
    const resumed = await new WorkflowRunner(store).run(workflow, { runId: 'r', recoverInterrupted: 'replay-safe' });
    expect(resumed.status).toBe('failed'); expect(resumed.steps.accounts).toMatchObject({ status: 'failed', attempts: 1 });
    const result = await new WorkflowRunner(store).rearm(workflow, { runId: 'r', steps: 'incomplete', acknowledgement });
    expect(result.rearmed).toEqual([{ stepId: 'accounts', status: 'failed', attempts: 1 }]);
    expect(result.checkpoint).toMatchObject({ status: 'halted', steps: { signals: { status: 'completed', output: 'ready' }, accounts: { status: 'pending', attempts: 0 } } });
    expect(result.checkpoint.steps.accounts).not.toHaveProperty('error');
    const completed = await new WorkflowRunner(store).run(workflow, { runId: 'r', recoverInterrupted: 'replay-safe' });
    expect(completed.status).toBe('completed');
    expect(calls).toEqual([['signals', 1], ['accounts', 1], ['accounts', 1]]);
    expect(new Set(keys).size).toBe(1);
  });

  it('re-arms only the named non-completed steps and leaves the rest untouched', async () => {
    const { store } = await fixture();
    const workflow = definition([
      { id: 'a', execute: () => 'a' }, { id: 'b', execute() { throw new Error('b failed'); } }, { id: 'c', execute() { throw new Error('c failed'); } },
    ]);
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'partial' })).status).toBe('failed');
    const result = await new WorkflowRunner(store).rearm(workflow, { runId: 'partial', steps: ['b'], acknowledgement });
    expect(result.rearmed).toEqual([{ stepId: 'b', status: 'failed', attempts: 1 }]);
    expect(result.checkpoint.steps).toMatchObject({ a: { status: 'completed' }, b: { status: 'pending', attempts: 0 }, c: { status: 'failed', attempts: 1, error: 'c failed' } });
    const lease = await store.acquire('partial');
    expect(await lease.load()).toEqual(result.checkpoint);
    await lease.release();
  });

  it('re-arms the blocked dependants of a named step, transitively, so the run can complete', async () => {
    const { store } = await fixture(); let failA = true; const calls: string[] = [];
    const workflow = definition([
      { id: 'A', execute() { calls.push('A'); if (failA) throw new Error('boom'); return 'a'; } },
      { id: 'B', dependencies: ['A'], execute() { calls.push('B'); return 'b'; } },
      { id: 'C', dependencies: ['B'], execute() { calls.push('C'); return 'c'; } },
      { id: 'D', execute() { calls.push('D'); return 'd'; } },
    ]);
    const first = await new WorkflowRunner(store).run(workflow, { runId: 'e1' });
    expect(first.status).toBe('failed');
    expect(first.steps).toMatchObject({ A: { status: 'failed' }, B: { status: 'blocked' }, C: { status: 'blocked' }, D: { status: 'completed' } });
    failA = false;
    const result = await new WorkflowRunner(store).rearm(workflow, { runId: 'e1', steps: ['A'], acknowledgement });
    expect(result.rearmed).toEqual([
      { stepId: 'A', status: 'failed', attempts: 1 },
      { stepId: 'B', status: 'blocked', attempts: 0 },
      { stepId: 'C', status: 'blocked', attempts: 0 },
    ]);
    expect(result.checkpoint.steps).toMatchObject({ B: { status: 'pending', attempts: 0 }, C: { status: 'pending', attempts: 0 }, D: { status: 'completed', output: 'd' } });
    expect(result.checkpoint.steps.B).not.toHaveProperty('error');
    const done = await new WorkflowRunner(store).run(workflow, { runId: 'e1' });
    expect(done.status).toBe('completed');
    expect(calls).toEqual(['A', 'D', 'A', 'B', 'C']);
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'e1' })).status).toBe('completed');
    expect((await new WorkflowRunner(store).rearm(workflow, { runId: 'e1', steps: 'incomplete', acknowledgement })).rearmed).toEqual([]);
  });

  it('leaves a blocked dependant blocked when another of its dependencies is still failed, and persists a valid status', async () => {
    const { store } = await fixture(); let failA = true;
    const workflow = definition([
      { id: 'A', execute() { if (failA) throw new Error('a'); return 'a'; } },
      { id: 'X', execute() { throw new Error('x'); } },
      { id: 'B', dependencies: ['A', 'X'], execute: () => 'b' },
    ]);
    await new WorkflowRunner(store).run(workflow, { runId: 'two' });
    failA = false;
    const result = await new WorkflowRunner(store).rearm(workflow, { runId: 'two', steps: ['A'], acknowledgement });
    expect(result.rearmed.map(item => item.stepId)).toEqual(['A', 'B']);
    const again = await new WorkflowRunner(store).run(workflow, { runId: 'two' });
    expect(again).toMatchObject({ status: 'failed', steps: { A: { status: 'completed' }, X: { status: 'failed' }, B: { status: 'blocked' } } });
    const fixed = await new WorkflowRunner(store).rearm(workflow, { runId: 'two', steps: 'incomplete', acknowledgement });
    expect(fixed.rearmed.map(item => item.stepId)).toEqual(['X', 'B']);
  });

  it('never persists a terminal failed status without a failed step: a run that only finds blocked work halts', async () => {
    const { store } = await fixture();
    const workflow = definition([{ id: 'A', execute: () => 'a' }, { id: 'B', dependencies: ['A'], execute: () => 'b' }]);
    // A checkpoint whose dependant was left blocked while its dependency was re-armed.
    const lease = await store.acquire('stuck');
    await lease.save({ format: 1, runId: 'stuck', workflow: identity(workflow), status: 'halted', steps: { A: { status: 'pending', attempts: 0 }, B: { status: 'blocked', attempts: 0, error: 'A dependency did not complete' } } });
    await lease.release();
    const result = await new WorkflowRunner(store).run(workflow, { runId: 'stuck' });
    expect(result.status).toBe('halted');
    expect(result.steps).toMatchObject({ A: { status: 'completed' }, B: { status: 'blocked' } });
    // The persisted checkpoint still validates: a later run and a re-arm both read it.
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'stuck' })).status).toBe('halted');
    const rearmed = await new WorkflowRunner(store).rearm(workflow, { runId: 'stuck', steps: ['B'], acknowledgement });
    expect(rearmed.rearmed).toEqual([{ stepId: 'B', status: 'blocked', attempts: 0 }]);
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'stuck' })).status).toBe('completed');
  });

  it('refuses a completed step, an unknown step, a missing acknowledgement, a changed definition and a missing checkpoint', async () => {
    const { store } = await fixture(); const workflow = definition([{ id: 'a', execute: () => 'a' }, { id: 'b', execute() { throw new Error('no'); } }]);
    await new WorkflowRunner(store).run(workflow, { runId: 'refuse' });
    const runner = new WorkflowRunner(store);
    await expect(runner.rearm(workflow, { runId: 'refuse', steps: ['a'], acknowledgement })).rejects.toThrow(/completed/i);
    await expect(runner.rearm(workflow, { runId: 'refuse', steps: ['zzz'], acknowledgement })).rejects.toThrow(/unknown step/i);
    await expect(runner.rearm(workflow, { runId: 'refuse', steps: [], acknowledgement })).rejects.toThrow(/steps/i);
    await expect(runner.rearm(workflow, { runId: 'refuse', steps: 'incomplete', acknowledgement: { workStopped: false } as never })).rejects.toThrow(/acknowledge/i);
    await expect(runner.rearm(workflow, { runId: 'refuse', steps: 'incomplete' } as never)).rejects.toThrow(/acknowledge/i);
    await expect(runner.rearm({ ...workflow, version: 'v2' }, { runId: 'refuse', steps: 'incomplete', acknowledgement })).rejects.toThrow(/definition/i);
    await expect(runner.rearm(workflow, { runId: 'never-ran', steps: 'incomplete', acknowledgement })).rejects.toThrow(/checkpoint/i);
    const lease = await store.acquire('refuse');
    expect(await lease.load()).toMatchObject({ status: 'failed', steps: { b: { status: 'failed' } } });
    await lease.release();
    expect(await store.inspectOwnership('refuse')).toBeUndefined();
  });

  it('cannot re-arm a run another process owns and writes nothing when nothing needs re-arming', async () => {
    const { store, directory } = await fixture(); const gate = deferred(); let calls = 0; const saves: unknown[] = [];
    const workflow = definition([{ id: 'a', async execute() { calls++; await gate.promise; return 'a'; } }]);
    const running = new WorkflowRunner(store).run(workflow, { runId: 'owned' }); await until(() => calls === 1);
    await expect(new WorkflowRunner(new FileWorkflowStore(directory)).rearm(workflow, { runId: 'owned', steps: 'incomplete', acknowledgement }))
      .rejects.toBeInstanceOf(WorkflowRunLockedError);
    gate.resolve(); await running;
    const counting: WorkflowStore = { async acquire(runId) { const lease = await store.acquire(runId); return { ...lease, save(cp) { saves.push(cp); return lease.save(cp); } }; } };
    const result = await new WorkflowRunner(counting).rearm(workflow, { runId: 'owned', steps: 'incomplete', acknowledgement });
    expect(result.rearmed).toEqual([]); expect(result.checkpoint.status).toBe('completed'); expect(saves).toEqual([]);
  });

  it('a repeated re-arm is a true no-op: steps already pending with no attempt are neither reported nor rewritten', async () => {
    const { store } = await fixture(); const saves: unknown[] = [];
    const workflow = definition([
      { id: 'a', execute: () => 'a' }, { id: 'b', maxAttempts: 2, execute() { throw new Error('b failed'); } },
      { id: 'c', dependencies: ['b'], execute: () => 'c' },
    ]);
    await new WorkflowRunner(store).run(workflow, { runId: 'twice' });
    const first = await new WorkflowRunner(store).rearm(workflow, { runId: 'twice', steps: 'incomplete', acknowledgement });
    expect(first.rearmed.map(item => item.stepId)).toEqual(['b', 'c']);
    const counting: WorkflowStore = { async acquire(runId) { const lease = await store.acquire(runId); return { ...lease, save(cp) { saves.push(cp); return lease.save(cp); } }; } };
    const again = await new WorkflowRunner(counting).rearm(workflow, { runId: 'twice', steps: 'incomplete', acknowledgement });
    expect(again.rearmed).toEqual([]); expect(saves).toEqual([]);
    expect(again.checkpoint).toEqual(first.checkpoint);
    const named = await new WorkflowRunner(counting).rearm(workflow, { runId: 'twice', steps: ['b', 'c'], acknowledgement });
    expect(named.rearmed).toEqual([]); expect(saves).toEqual([]);
  });
});
