import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';

/**
 * Phase 1 acceptance, third case of plan task 9: an app process dies by SIGKILL while it holds admissions in the
 * shared ledger. Reopening keeps them, only the exact inspected set can be released, and no other app can release them.
 */
const SOURCE = new URL('../../src/orchestration/budget/host-ledger.ts', import.meta.url).href;
const concurrency = { mode: 'limited', maxConcurrent: 2 } as const;
const acknowledgement = { workStopped: true as const, evidenceDigest: 'c'.repeat(64) };
const dirs: string[] = [], ledgers: HostLedger[] = [], children: ChildProcess[] = [];

function open(databasePath: string) { const ledger = new HostLedger({ databasePath, concurrency }); ledgers.push(ledger); return ledger; }
function state(ledger: HostLedger) { const result = ledger.status('claude'); if (!result.ok) throw new Error(result.reason); return result.status; }
const owners = (ledger: HostLedger) => state(ledger).reservations.map(reservation => reservation.owner).sort();

/** A separate process takes one hold as another app would, reports its token and is then killed without any cleanup. */
async function holdThenCrash(databasePath: string, owner: string): Promise<string> {
  const script = `import { HostLedger } from ${JSON.stringify(SOURCE)};
    const ledger = new HostLedger({ databasePath: process.argv[1], concurrency: ${JSON.stringify(concurrency)} });
    const held = ledger.reserve('claude', process.argv[2]);
    if (!held.allowed) throw new Error(held.reason);
    process.stdout.write(held.reservation.token + '\\n');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, databasePath, owner],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '', diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The holder did not report a hold within 15 s: ${diagnostics}`)), 15_000);
    const settle = (action: () => void) => { clearTimeout(timer); action(); };
    child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('\n')) settle(() => resolve(output.trim())); });
    child.once('error', error => settle(() => reject(error)));
    child.once('exit', code => settle(() => reject(new Error(`The holder exited (${code}) before reporting a hold: ${diagnostics}`))));
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exited;
  expect(signal).toBe('SIGKILL');
  return token;
}

afterEach(() => {
  children.splice(0).forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  ledgers.splice(0).forEach(ledger => ledger.close());
  dirs.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

test('a killed app keeps its holds across a reopen; only the inspected set is released and another app cannot release it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oar-host-crash-')); dirs.push(directory);
  const file = join(directory, 'admission.sqlite');
  const grow = open(file);
  const growHold = grow.reserve('claude', 'grow:run-b'); if (!growHold.allowed) throw new Error(growHold.reason);

  const marketingToken = await holdThenCrash(file, 'marketing:run-a');

  // Reopening after the kill: nothing was released because a process disappeared, and the dead hold still counts.
  const reopened = open(file);
  expect(owners(reopened)).toEqual(['grow:run-b', 'marketing:run-a']);
  expect(reopened.reserve('claude', 'marketing:run-c')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  expect(state(reopened)).toMatchObject({ active: 2, launchesLastDay: 2 });

  // The other app cannot release a hold that is not under its own prefix.
  expect(grow.recover({ ownerPrefix: 'grow:', tokens: [marketingToken], acknowledgement })).toMatchObject({ ok: false, reason: 'invalid-input' });
  expect(owners(grow)).toEqual(['grow:run-b', 'marketing:run-a']);

  // Explicit recovery of exactly what was inspected, with the work-stopped acknowledgement.
  const inspected = state(reopened).reservations.filter(reservation => reservation.owner.startsWith('marketing:')).map(reservation => reservation.token);
  expect(inspected).toEqual([marketingToken]);
  expect(reopened.recover({ ownerPrefix: 'marketing:', tokens: inspected, acknowledgement })).toEqual({ ok: true, released: 1 });

  // The live app's hold is untouched and the launch already counted is not refunded.
  expect(owners(grow)).toEqual(['grow:run-b']);
  expect(state(grow)).toMatchObject({ active: 1, launchesLastDay: 2 });
  expect(grow.release(growHold.reservation.token)).toMatchObject({ ok: true, released: true });
}, 30_000);
