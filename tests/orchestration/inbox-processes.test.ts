import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, expect, test } from 'vitest';
import { emailRequest, inboxFixture, must } from './inbox-fixture.js';

interface WorkerMessage {
  event: 'ready' | 'result' | 'error';
  pid: number;
  result?: { ok: boolean; reason?: string; requestId?: string; created?: boolean };
  detail?: string;
}

const cleanups: (() => void)[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function bundleWorker(directory: string): Promise<string> {
  const entry = join(directory, 'worker.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./inbox-fixtures/worker.ts', import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  return entry;
}

function next(child: ChildProcess, event: WorkerMessage['event']): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker ${child.pid} never sent ${event}`)), 20_000);
    child.on('message', (message: WorkerMessage) => {
      if (message.event === 'error') {
        clearTimeout(timer);
        reject(new Error(message.detail));
      } else if (message.event === event) {
        clearTimeout(timer);
        resolve(message);
      }
    });
    child.once('error', reject);
  });
}

/** Starts every contender, waits until all are ready, and only then lets them all go at once. */
async function race(entry: string, count: number, args: string[]): Promise<WorkerMessage[]> {
  const started = Array.from({ length: count }, () => {
    const child = fork(entry, args, { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child);
    return child;
  });
  await Promise.all(started.map((child) => next(child, 'ready')));
  const results = started.map((child) => next(child, 'result'));
  for (const child of started) child.send('go');
  return Promise.all(results);
}

test('of eight processes that use the same approval at once, exactly one succeeds', async () => {
  const fixture = inboxFixture();
  cleanups.push(fixture.cleanup);
  const entry = await bundleWorker(fixture.directory);
  const grow = fixture.system('grow', ['email.send']);
  const desk = fixture.owner();
  const filed = must(grow.request(emailRequest()));
  // The workers run on the real clock; the fixture clock only stamps the setup.
  must(desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));

  const outcomes = await race(entry, 8, ['consume', fixture.file, filed.requestId]);

  expect(new Set(outcomes.map((outcome) => outcome.pid)).size).toBe(8);
  const winners = outcomes.filter((outcome) => outcome.result?.ok);
  expect(winners).toHaveLength(1);
  const losers = outcomes.filter((outcome) => !outcome.result?.ok);
  expect(losers.map((outcome) => outcome.result?.reason)).toEqual(Array(7).fill('already-used'));

  const item = must(desk.inspect(filed.requestId)).item;
  expect(item.status).toBe('consumed');
  const consumed = item.transitions.filter((transition) => transition.to === 'consumed');
  expect(consumed).toHaveLength(1);
  expect(consumed[0]!.by).toBe(`grow:pid-${winners[0]!.pid}`);
  expect(item.refusedUses).toBe(7);
}, 30_000);

test('eight processes that open a missing inbox and file the same action create one file and one request', async () => {
  const fixture = inboxFixture();
  cleanups.push(fixture.cleanup);
  const entry = await bundleWorker(fixture.directory);

  const outcomes = await race(entry, 8, ['request', fixture.file]);

  expect(outcomes.every((outcome) => outcome.result?.ok)).toBe(true);
  expect(new Set(outcomes.map((outcome) => outcome.result?.requestId)).size).toBe(1);
  expect(outcomes.filter((outcome) => outcome.result?.created)).toHaveLength(1);
}, 30_000);
