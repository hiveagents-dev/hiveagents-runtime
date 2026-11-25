/**
 * Probe (W1 finding): a crash inside `recoverAbandoned` leaves a run that the journal API can no
 * longer recover.
 *
 * `recoverAbandoned` hard-links the lock to `<lock>.recovered-<token>`, re-reads it, then unlinks the
 * lock. A process killed between the link and the unlink leaves both the lock (dead owner) and the
 * tombstone. Every later `recoverAbandoned(runId, sameToken)` then throws "already recovered with this
 * token", and `open` throws DynamicJournalLockedError: only a manual `rm` of the lock unblocks the run.
 *
 * Part 1 builds that state deterministically (a dead owner's lock + the tombstone the interrupted call
 * had created). Part 2 SIGKILLs real processes inside `recoverAbandoned` at random delays and counts
 * how often the run ends up stuck.
 *
 * Usage: node scripts/simulation/workflows/probe-recover.mjs [--attempts 200]
 */
import { spawn } from 'node:child_process';
import { linkSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { emit, sdk } from '../lib/sim.mjs';
import { flags } from './lib-twin.mjs';

const SELF = fileURLToPath(import.meta.url);

async function childRecover(directory, runId) {
  const { fileDynamicJournal } = await sdk('orchestration/dynamic');
  const journal = fileDynamicJournal(directory);
  const owner = await journal.inspectOwner(runId);
  if (owner) await journal.recoverAbandoned(runId, owner.token, { ownerStopped: true });
}

function deadLock(directory, runId) {
  // A lock as `#acquire` writes it, owned by a PID that is not running (a crashed writer).
  const token = randomUUID();
  writeFileSync(join(directory, `${runId}.lock`), JSON.stringify({ format: 1, runId, token, pid: 2 ** 22 - 3, host: hostname() }));
  return token;
}

async function attemptAfter(dynamic, directory, runId) {
  const journal = dynamic.fileDynamicJournal(directory);
  let recover = 'ok', open = 'ok';
  try {
    const owner = await journal.inspectOwner(runId);
    if (owner) await journal.recoverAbandoned(runId, owner.token, { ownerStopped: true });
  } catch (error) { recover = String(error.message); }
  try { await journal.open(runId); await journal.close(runId); } catch (error) { open = `${error.name}: ${error.message}`; }
  return { recover, open };
}

async function main() {
  const opts = flags({ attempts: 200 });
  const dynamic = await sdk('orchestration/dynamic');
  const runId = 'stuck-run';

  // Part 1: deterministic state.
  const one = mkdtempSync(join(tmpdir(), 'oar-recover-'));
  const token = deadLock(one, runId);
  linkSync(join(one, `${runId}.lock`), join(one, `${runId}.lock.recovered-${token}`)); // what the killed call had done
  const deterministic = await attemptAfter(dynamic, one, runId);
  rmSync(one, { recursive: true, force: true });

  // Part 2: real SIGKILLs inside recoverAbandoned.
  let stuck = 0, recovered = 0, untouched = 0;
  for (let i = 0; i < opts.attempts; i++) {
    const directory = mkdtempSync(join(tmpdir(), 'oar-recover-'));
    deadLock(directory, runId);
    const delay = 60 + Math.random() * 140;
    await new Promise(resolve => {
      const proc = spawn(process.execPath, [SELF, '--child', directory, runId], { stdio: 'ignore' });
      const timer = setTimeout(() => proc.kill('SIGKILL'), delay);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!existsSync(join(directory, `${runId}.lock`))) recovered++;
    else {
      const after = await attemptAfter(dynamic, directory, runId);
      if (after.recover === 'ok' && after.open === 'ok') untouched++; else stuck++;
    }
    rmSync(directory, { recursive: true, force: true });
  }
  emit('workflows/probe-recover', [{
    finding: 'A SIGKILL between the tombstone link and the lock unlink of recoverAbandoned leaves the run unrecoverable through the API',
    deterministic: { expected: 'recoverAbandoned succeeds (owner dead, same host, same token) and open succeeds', actual: deterministic },
    sigkillInsideRecover: { attempts: opts.attempts, lockRemovedBeforeKill: recovered, stillRecoverable: untouched, stuck },
    assumptions: { kill: 'parent SIGKILL at uniform 60..200 ms after spawning a process that only imports the SDK and calls inspectOwner + recoverAbandoned' },
  }]);
}

if (process.argv[2] === '--child') await childRecover(process.argv[3], process.argv[4]);
else await main();
