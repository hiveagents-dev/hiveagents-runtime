import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import { inspectManagedEffect } from '../../src/orchestration/log/effects.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const identity = logDraft().identity;
const association = { identity, stepId: 'effect', effectKey: 'effect', operation: { id: 'owned-write', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
async function fixture() {
  const files = logDirectory(); cleanup.push(files.cleanup); const entry = join(files.directory, 'decision-worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./log-store-fixtures/decision-worker.ts', import.meta.url))], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return { ...files, entry, target: join(files.directory, 'owned-effect.txt') };
}
function run(entry: string, file: string, target: string, mode: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, file, target, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', bytes => { output += String(bytes); if (output.length > 4096) child.kill('SIGKILL'); }); child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}
it.each([
  { mode: 'intent', persisted: 'intent', recovered: 'needs-owner', effects: 0 },
  { mode: 'effect', persisted: 'intent', recovered: 'needs-owner', effects: 1 },
  { mode: 'dispatched', persisted: 'dispatched', recovered: 'verified', effects: 1 },
  { mode: 'verified', persisted: 'verified', recovered: 'verified', effects: 1 },
  { mode: 'ackloss', persisted: 'verified', recovered: 'verified', effects: 1 },
])('fresh processes recover $mode without automatic lease takeover or another external effect', async ({ mode, persisted, recovered, effects }) => {
  const { entry, file, target } = await fixture(), crashed = await run(entry, file, target, mode);
  if (mode === 'ackloss') expect(JSON.parse(crashed.output)).toEqual({ halted: true }); else expect(crashed.signal).toBe('SIGKILL');
  const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => database.close());
  expect(inspectManagedEffect(database, association)?.record?.status).toBe(persisted);
  const owner = database.inspectOwnership('decision', identity)!; expect(owner).toBeDefined();
  const denied = await run(entry, file, target, 'resume'); expect(JSON.parse(denied.output)).toEqual({ halted: true });
  expect(() => database.recoverAbandoned({ ...owner, ownerId: '0'.repeat(36) }, { ownerStopped: true })).toThrow();
  // The test owns and observed this exact child exit; this is only standalone operator acknowledgement.
  database.recoverAbandoned(owner, { ownerStopped: true });
  const resumed = await run(entry, file, target, 'resume'); expect(resumed.code).toBe(0); expect(JSON.parse(resumed.output).status).toBe(recovered);
  if (recovered === 'verified') expect(JSON.parse(resumed.output).result).toEqual({ original: 'owned-result' });
  expect(existsSync(target) ? readFileSync(target, 'utf8').trim().split('\n').length : 0).toBe(effects);
  expect(inspectManagedEffect(database, association)?.record?.status).toBe(recovered);
}, 15000);
it('two actual fresh execution processes cannot duplicate the same managed effect', async () => {
  const { entry, file, target } = await fixture(), results = await Promise.all([run(entry, file, target, 'resume'), run(entry, file, target, 'resume')]);
  for (const result of results) { expect(result.code).toBe(0); const value = JSON.parse(result.output); expect(value.status === 'verified' || value.halted === true).toBe(true); }
  expect(readFileSync(target, 'utf8')).toBe('owned-effect\n');
  const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => database.close());
  expect(inspectManagedEffect(database, association)?.record?.status).toBe('verified');
}, 15000);
it('fresh WorkflowRunner cannot replay a crashed managed effect despite replaySafe, after exact standalone recovery', async () => {
  const { entry, file, target } = await fixture(); expect((await run(entry, file, target, 'wf-effect')).signal).toBe('SIGKILL');
  const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => database.close());
  expect(inspectManagedEffect(database, association)?.record?.status).toBe('intent');
  for (const kind of ['decision', 'workflow'] as const) {
    const owner = database.inspectOwnership(kind, identity); expect(owner).toBeDefined(); database.recoverAbandoned(owner!, { ownerStopped: true });
  }
  const resumed = await run(entry, file, target, 'wf-resume'); expect(JSON.parse(resumed.output)).toEqual({ halted: true });
  expect(readFileSync(target, 'utf8')).toBe('owned-effect\n'); expect(inspectManagedEffect(database, association)?.record?.status).toBe('intent');
}, 15000);
