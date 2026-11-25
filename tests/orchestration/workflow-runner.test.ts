import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWorkflowStore, WorkflowRunner, WorkflowRunLockedError,
  type WorkflowDefinition, type WorkflowStep,
} from '../../src/orchestration/workflow/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-'));
  directories.push(directory);
  const store = new FileWorkflowStore(directory);
  return { directory, store, runner: new WorkflowRunner(store) };
}
const definition = (steps: readonly WorkflowStep[]): WorkflowDefinition => ({ id: 'test', version: '1', steps });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Condition did not become true');
}

describe('WorkflowRunner', () => {
  it('runs actual callbacks with bounded concurrency, wave barriers and dependency outputs', async () => {
    const { runner } = await fixture();
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    let active = 0; let peak = 0;
    const first: WorkflowStep[] = ['a', 'b', 'c'].map((id, index) => ({
      id, async execute() {
        started.push(id); peak = Math.max(peak, ++active);
        await gates[index]!.promise; active--;
        return { value: id };
      },
    }));
    const run = runner.run(definition([...first, {
      id: 'join', dependencies: ['a', 'b'], execute({ dependencyOutputs }) {
        started.push('join');
        expect(dependencyOutputs).toEqual({ a: { value: 'a' }, b: { value: 'b' } });
        return 'joined';
      },
    }]), { runId: 'bounded', concurrency: 2 });
    await until(() => started.length === 2);
    expect(started).toEqual(['a', 'b']);
    gates[0]!.resolve();
    await until(() => started.length === 3);
    gates[1]!.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toEqual(['a', 'b', 'c']);
    gates[2]!.resolve();
    const result = await run;
    expect(result.status).toBe('completed');
    expect(result.steps.join).toMatchObject({ status: 'completed', output: 'joined', attempts: 1 });
    expect(peak).toBe(2);
  });

  it('drains active work on cancellation and resumes without executing completed steps again', async () => {
    const { store, runner } = await fixture();
    const abort = new AbortController();
    const gates = [deferred(), deferred()];
    const calls: string[] = [];
    const workflow = definition(['a', 'b', 'c'].map((id, index) => ({
      id, async execute() { calls.push(id); await gates[index]?.promise; return id; },
    })));
    let settled = false;
    const run = runner.run(workflow, { runId: 'resume', concurrency: 2, signal: abort.signal });
    void run.then(() => { settled = true; });
    await until(() => calls.length === 2);
    abort.abort(); gates[0]!.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(calls).toEqual(['a', 'b']);
    gates[1]!.resolve();
    expect((await run).status).toBe('cancelled');
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'resume' })).status).toBe('completed');
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('preserves consumed attempts and stable idempotency keys across an interrupted resume', async () => {
    const { store, runner } = await fixture();
    const abort = new AbortController();
    const attempts: number[] = []; const keys: string[] = [];
    const workflow = definition([{
      id: 'task', maxAttempts: 2, replaySafe: true,
      execute({ attempt, idempotencyKey }) {
        attempts.push(attempt); keys.push(idempotencyKey);
        if (attempt === 1) { abort.abort(); throw new Error('interrupted'); }
        throw new Error('still unavailable');
      },
    }, { id: 'child', dependencies: ['task'], execute() { throw new Error('must never run'); } }]);
    expect((await runner.run(workflow, { runId: 'retry', signal: abort.signal })).status).toBe('cancelled');
    const resumed = await new WorkflowRunner(store).run(workflow, { runId: 'retry', recoverInterrupted: 'replay-safe' });
    expect(resumed.status).toBe('failed');
    expect(resumed.steps.task).toMatchObject({ status: 'failed', attempts: 2 });
    expect(resumed.steps.child).toMatchObject({ status: 'blocked', attempts: 0 });
    expect(attempts).toEqual([1, 2]);
    expect(keys[0]).toBe(keys[1]);
    await new WorkflowRunner(store).run(workflow, { runId: 'retry', recoverInterrupted: 'replay-safe' });
    expect(attempts).toEqual([1, 2]);
  });

  it('halts ambiguous interrupted work without explicit replay permission', async () => {
    const { store, runner } = await fixture(); const abort = new AbortController();
    let calls = 0;
    const workflow = definition([{ id: 'task', maxAttempts: 3, execute() {
      calls++; abort.abort(); throw new Error('outcome unknown');
    } }]);
    await runner.run(workflow, { runId: 'ambiguous', signal: abort.signal });
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'ambiguous' })).status).toBe('halted');
    expect((await new WorkflowRunner(store).run(workflow, { runId: 'ambiguous', recoverInterrupted: 'replay-safe' })).status).toBe('halted');
    expect(calls).toBe(1);
  });

  it('persists normal retry attempts and never runs a dependency of a failed step', async () => {
    const { runner } = await fixture(); const calls: number[] = []; let childCalls = 0;
    const result = await runner.run(definition([
      { id: 'task', maxAttempts: 3, execute({ attempt }) { calls.push(attempt); throw new Error('failure'); } },
      { id: 'child', dependencies: ['task'], execute() { childCalls++; return null; } },
      { id: 'grandchild', dependencies: ['child'], execute() { childCalls++; return null; } },
    ]), { runId: 'failure' });
    expect(result.status).toBe('failed'); expect(calls).toEqual([1, 2, 3]); expect(childCalls).toBe(0);
    expect(result.steps.grandchild?.status).toBe('blocked');
  });

  it.each([NaN, Infinity, undefined, new Date(), { nested: undefined }, (() => 1), Array(2), { get changing() { return undefined; } }, Object.defineProperty({}, 'toJSON', { value: () => 'surprise' })])(
    'refuses outputs that cannot be persisted as JSON without changing meaning: %s', async output => {
      const { runner } = await fixture();
      const result = await runner.run(definition([{ id: 'bad', execute: () => output as never }]), { runId: 'json' });
      expect(result.status).toBe('failed'); expect(result.steps.bad?.error).toMatch(/JSON/i);
    },
  );

  it('handles adversarial identifiers without prototype inheritance or path traversal', async () => {
    const { runner } = await fixture();
    const result = await runner.run(definition([
      { id: '__proto__', execute: () => 'safe' },
      { id: 'constructor', dependencies: ['__proto__'], execute: ({ dependencyOutputs }) => dependencyOutputs['__proto__']! },
      { id: '../outside', dependencies: ['constructor'], execute: ({ dependencyOutputs }) => dependencyOutputs.constructor! as never },
    ]), { runId: '../../outside' });
    expect(result.status).toBe('completed');
    expect(Object.hasOwn(result.steps, '__proto__')).toBe(true);
    expect(result.steps['../outside']?.output).toBe('safe');
  });

  it('refuses accessor outputs whose second read would serialize differently', async () => {
    const { runner } = await fixture(); let reads = 0;
    const output = { get changing() { return ++reads === 1 ? 42 : undefined; } };
    const result = await runner.run(definition([{ id: 'accessor', execute: () => output as never }]), { runId: 'accessor' });
    expect(result.status).toBe('failed'); expect(result.steps.accessor?.error).toMatch(/JSON/i);
  });

  it('refuses definition/version/graph changes before starting any resumed callback', async () => {
    const { runner } = await fixture(); let calls = 0;
    const workflow = definition([{ id: 'task', execute() { calls++; return 'ok'; } }]);
    await runner.run(workflow, { runId: 'bound' });
    await expect(runner.run({ ...workflow, version: '2' }, { runId: 'bound' })).rejects.toThrow(/definition/i);
    await expect(runner.run(definition([...workflow.steps, { id: 'other', execute: () => null }]), { runId: 'bound' })).rejects.toThrow(/definition/i);
    expect(calls).toBe(1);
  });

  it('rejects an overlapping same-run execution through distinct store instances', async () => {
    const { runner, directory } = await fixture(); const gate = deferred(); let calls = 0;
    const workflow = definition([{ id: 'task', async execute() { calls++; await gate.promise; return null; } }]);
    const first = runner.run(workflow, { runId: 'same' }); await until(() => calls === 1);
    await expect(new WorkflowRunner(new FileWorkflowStore(directory)).run(workflow, { runId: 'same' })).rejects.toBeInstanceOf(WorkflowRunLockedError);
    gate.resolve(); await first;
    await new WorkflowRunner(new FileWorkflowStore(directory)).run(workflow, { runId: 'same' });
    expect(calls).toBe(1);
  });

  it('rejects a corrupt checkpoint before any callback is invoked', async () => {
    const { runner, directory } = await fixture(); let calls = 0;
    const workflow = definition([{ id: 'task', execute() { calls++; return { answer: 42 }; } }]);
    await runner.run(workflow, { runId: 'corrupt' });
    const filename = (await readdir(directory)).find(file => file.endsWith('.json'))!;
    const path = join(directory, filename); const stored = await readFile(path, 'utf8');
    await writeFile(path, stored.replace('42', '43'));
    await expect(runner.run(workflow, { runId: 'corrupt' })).rejects.toThrow(/checksum|corrupt/i);
    expect(calls).toBe(1);
  });
});
