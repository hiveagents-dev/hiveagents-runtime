import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWorkflowStore, WorkflowRunner, type WorkflowDefinition, type WorkflowStepContext,
} from '../../src/orchestration/workflow/index.js';

const directories: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
  }
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture(replaySafe: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-crash-')); directories.push(directory);
  const script = join(directory, 'fixture.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./workflow-fixtures/crash.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile: script });
  const child = fork(script, [directory, 'crash', String(replaySafe)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  const [message] = await once(child, 'message');
  expect(message).toEqual({ type: 'executing' });
  const store = new FileWorkflowStore(directory);
  async function record(context: WorkflowStepContext) {
    await appendFile(join(directory, 'executions.jsonl'), `${JSON.stringify({
      step: context.stepId, attempt: context.attempt, key: context.idempotencyKey,
    })}\n`);
  }
  const definition: WorkflowDefinition = { id: 'crash-fixture', version: '1', steps: [
    { id: 'intake', async execute(context) { await record(context); return 'ready'; } },
    { id: 'work', dependencies: ['intake'], maxAttempts: 2, replaySafe, async execute(context) { await record(context); return 'work'; } },
    { id: 'finish', dependencies: ['work'], async execute(context) { await record(context); return 'done'; } },
  ] };
  const records = async () => (await readFile(join(directory, 'executions.jsonl'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { step: string; attempt: number; key: string });
  const kill = async () => { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; };
  return { directory, script, store, definition, records, kill };
}

describe('durable workflow process boundary', () => {
  it('rejects another process and requires an explicit stopped-owner assertion for crash recovery', async () => {
    const { directory, script, store, records, kill } = await fixture(true);
    const owner = (await store.inspectOwnership('crash'))!;
    const contender = fork(script, [directory, 'contender', 'true'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(contender);
    const [message] = await once(contender, 'message');
    expect(message).toEqual({ type: 'error', name: 'WorkflowRunLockedError' });
    expect((await records()).map(record => record.step)).toEqual(['intake', 'work']);
    await expect(store.recoverAbandoned('crash', owner.token, { ownerStopped: true })).rejects.toThrow(/alive/i);
    await kill();
    await expect(store.recoverAbandoned('crash', owner.token, undefined as never)).rejects.toThrow(/verified|stopped|acknowledge/i);
    await store.recoverAbandoned('crash', owner.token, { ownerStopped: true });
    expect(await store.inspectOwnership('crash')).toBeUndefined();
  });

  it('keeps completed output through SIGKILL, halts by default, and consumes the remaining replay budget', async () => {
    const { store, definition, records, kill } = await fixture(true);
    const owner = (await store.inspectOwnership('crash'))!; await kill();
    const runner = new WorkflowRunner(store);
    await expect(runner.run(definition, { runId: 'crash' })).rejects.toThrow(/already owned/i);
    await store.recoverAbandoned('crash', owner.token, { ownerStopped: true });
    expect((await runner.run(definition, { runId: 'crash' })).status).toBe('halted');
    expect((await records()).map(record => record.step)).toEqual(['intake', 'work']);
    const result = await new WorkflowRunner(new FileWorkflowStore(store.directory)).run(definition, {
      runId: 'crash', recoverInterrupted: 'replay-safe',
    });
    expect(result.status).toBe('completed');
    const events = await records();
    expect(events.map(event => [event.step, event.attempt])).toEqual([['intake', 1], ['work', 1], ['work', 2], ['finish', 1]]);
    expect(events[1]!.key).toBe(events[2]!.key);
    expect(result.steps.intake?.output).toBe('ready');
  });

  it('never replays a non-replay-safe crashed callback even when recovery is requested', async () => {
    const { store, definition, records, kill } = await fixture(false);
    const owner = (await store.inspectOwnership('crash'))!; await kill();
    await store.recoverAbandoned('crash', owner.token, { ownerStopped: true });
    const result = await new WorkflowRunner(store).run(definition, { runId: 'crash', recoverInterrupted: 'replay-safe' });
    expect(result.status).toBe('halted');
    expect((await records()).map(record => record.step)).toEqual(['intake', 'work']);
  });

  it('permits only one concurrent recovery and refuses to remove a later owner token', async () => {
    const { store, kill } = await fixture(true);
    const owner = (await store.inspectOwnership('crash'))!; await kill();
    const outcomes = await Promise.allSettled([
      store.recoverAbandoned('crash', owner.token, { ownerStopped: true }),
      new FileWorkflowStore(store.directory).recoverAbandoned('crash', owner.token, { ownerStopped: true }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const lease = await store.acquire('crash');
    const current = await store.inspectOwnership('crash');
    await expect(store.recoverAbandoned('crash', owner.token, { ownerStopped: true })).rejects.toThrow(/token/i);
    expect(await store.inspectOwnership('crash')).toEqual(current);
    await lease.release();
  });
});
