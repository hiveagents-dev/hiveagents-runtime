import { spawn, spawnSync } from 'node:child_process';
import { link, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DynamicJournalLockedError, fileDynamicJournal } from '../../src/orchestration/dynamic/journal.js';

// `recoverAbandoned` interrupted at any point (a crash of the recovering process) must be completable by
// a retry with the same token, without ever removing a live owner's lock or letting two recoverers win.

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'oar-dynamic-recover-'));
  directories.push(dir);
  return dir;
}

const TOKEN = '00000000-0000-4000-8000-000000000000';
const ack = { ownerStopped: true } as const;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const owner = (pid: number, token = TOKEN, host = hostname()) => JSON.stringify({ format: 1, runId: 'run', token, pid, host });
const claim = (pid: number, host = hostname()) => JSON.stringify({ format: 1, pid, host, nonce: 'n' });

describe('fileDynamicJournal.recoverAbandoned after an interrupted recovery', () => {
  it('finishes a recovery killed between linking the tombstone and removing the lock', async () => {
    const dir = await directory();
    const lock = join(dir, 'run.lock');
    await writeFile(lock, owner(deadPid()));
    await link(lock, `${lock}.recovered-${TOKEN}`);
    const journal = fileDynamicJournal(dir);
    await expect(journal.open('run')).rejects.toBeInstanceOf(DynamicJournalLockedError);

    await journal.recoverAbandoned('run', TOKEN, ack);

    expect(await journal.inspectOwner('run')).toBeUndefined();
    await journal.open('run');
    await journal.close('run');
    // Done: the same token no longer names the owner.
    await expect(journal.recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/token/);
  });

  it('takes over the claim of a recoverer that died, but not one that is alive or on another host', async () => {
    const dir = await directory();
    const lock = join(dir, 'run.lock');
    await writeFile(lock, owner(deadPid()));
    const journal = fileDynamicJournal(dir);
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await writeFile(`${lock}.recovering-${TOKEN}.0`, claim(live.pid!));
      await expect(journal.recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/in progress/);
      expect((await journal.inspectOwner('run'))?.token).toBe(TOKEN);
    } finally { live.kill('SIGKILL'); }
    await new Promise(resolve => live.once('exit', resolve));

    await writeFile(`${lock}.recovering-${TOKEN}.0`, claim(1, 'another-host'));
    await expect(journal.recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/another host/);

    await writeFile(`${lock}.recovering-${TOKEN}.0`, claim(deadPid()));
    await journal.recoverAbandoned('run', TOKEN, ack);
    expect(await journal.inspectOwner('run')).toBeUndefined();
    // The winner removes its own claim and leaves the dead one, which only ever grows the probe by one.
    expect((await readdir(dir)).filter(name => name.includes('.recovering-')).sort()).toEqual([`run.lock.recovering-${TOKEN}.0`]);
  });

  it('completes a recovery killed after removing the lock but before releasing its claim', async () => {
    const dir = await directory();
    const lock = join(dir, 'run.lock');
    await writeFile(lock, owner(deadPid()));
    await link(lock, `${lock}.recovered-${TOKEN}`);
    await writeFile(`${lock}.recovering-${TOKEN}.0`, claim(deadPid()));
    await rm(lock);
    const journal = fileDynamicJournal(dir);

    await journal.recoverAbandoned('run', TOKEN, ack);
    await journal.open('run');
    // Once a new owner holds the run, the old token is refused whatever claims are left behind.
    await expect(fileDynamicJournal(dir).recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/token/);
    await journal.close('run');
  });

  it('does not report an interrupted recovery as finished while its recoverer is still running', async () => {
    const dir = await directory();
    const lock = join(dir, 'run.lock');
    await writeFile(`${lock}.recovered-${TOKEN}`, owner(deadPid()));
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await writeFile(`${lock}.recovering-${TOKEN}.0`, claim(live.pid!));
      await expect(fileDynamicJournal(dir).recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/in progress/);
    } finally { live.kill('SIGKILL'); }
  });

  it('never removes a lock that a new owner took after the interrupted recovery', async () => {
    const dir = await directory();
    const lock = join(dir, 'run.lock');
    await writeFile(lock, owner(deadPid()));
    await link(lock, `${lock}.recovered-${TOKEN}`);
    await rm(lock); // the interrupted recovery had removed it after all
    const journal = fileDynamicJournal(dir);
    await journal.open('run');
    await expect(fileDynamicJournal(dir).recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/token/);
    expect((await journal.inspectOwner('run'))?.pid).toBe(process.pid);
    await journal.close('run');
  });

  it('lets exactly one of several concurrent recoverers win', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'run.lock'), owner(deadPid()));
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => fileDynamicJournal(dir).recoverAbandoned('run', TOKEN, ack)));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await fileDynamicJournal(dir).inspectOwner('run')).toBeUndefined();
    expect((await readdir(dir)).filter(name => name.includes('.recovering-'))).toEqual([]);
  });

  it('refuses an unreadable claim instead of guessing', async () => {
    const dir = await directory();
    const lock = join(dir, 'run.lock');
    await writeFile(lock, owner(deadPid()));
    await writeFile(`${lock}.recovering-${TOKEN}.0`, 'not json');
    await expect(fileDynamicJournal(dir).recoverAbandoned('run', TOKEN, ack)).rejects.toThrow(/inspect/);
    expect((await fileDynamicJournal(dir).inspectOwner('run'))?.token).toBe(TOKEN);
  });
});
