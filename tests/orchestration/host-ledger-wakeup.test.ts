import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';

const dirs: string[] = [], ledgers: HostLedger[] = [];
function path() { const d = mkdtempSync(join(tmpdir(), 'oar-host-wakeup-')); dirs.push(d); return join(d, 'ledger.sqlite'); }
function open(databasePath: string) {
  const l = new HostLedger({ databasePath, providers: { claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 80 } }, busyTimeoutMs: 1000 });
  ledgers.push(l); return l;
}
afterEach(() => { ledgers.splice(0).forEach(l => l.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

// A file watch only starts listening when the event loop next polls. A slot released before that
// used to ring a bell nobody heard, and the waiter slept until its deadline or the 30 s backstop.
test('a release that lands before the event loop turns still wakes the waiter', async () => {
  const file = path(), holder = open(file), waiter = open(file);
  const held = holder.reserve('claude', 'holder'); if (!held.allowed) throw Error(held.reason);
  const started = performance.now();
  const waiting = waiter.acquire('claude', 'waiter', { maxWaitMs: 3000 });
  holder.release(held.reservation.token);
  await expect(waiting).resolves.toMatchObject({ allowed: true });
  expect(performance.now() - started).toBeLessThan(1000);
});

test('the same holds for every waiter in turn', async () => {
  const file = path(), holder = open(file), waiter = open(file);
  for (let round = 0; round < 5; round += 1) {
    const held = holder.reserve('claude', 'holder'); if (!held.allowed) throw Error(held.reason);
    const started = performance.now();
    const waiting = waiter.acquire('claude', `waiter-${round}`, { maxWaitMs: 3000 });
    holder.release(held.reservation.token);
    const got = await waiting;
    if (!got.allowed) throw Error(`round ${round}: ${got.reason}`);
    expect(performance.now() - started).toBeLessThan(1000);
    waiter.release(got.reservation.token);
  }
});

test('an immediate attempt is still answered without waiting', async () => {
  const file = path(), holder = open(file), waiter = open(file);
  const held = holder.reserve('claude', 'holder'); if (!held.allowed) throw Error(held.reason);
  await expect(waiter.acquire('claude', 'waiter', { maxWaitMs: 0 })).resolves.toMatchObject({ allowed: false, reason: 'concurrency-limit' });
});

// A waiter woken by the bell re-arms its watch from inside the poll phase, so that watch only starts
// listening one loop turn later. A release landing in between used to be lost until the backstop.
test('a release that lands right after a woken waiter was refused again still wakes it', async () => {
  const file = path(), holder = open(file), waiter = open(file);
  const held = holder.reserve('claude', 'holder'); if (!held.allowed) throw Error(held.reason);
  const waiting = waiter.acquire('claude', 'waiter', { maxWaitMs: 3000 });
  await new Promise(resolve => setTimeout(resolve, 100));

  let armed = true;
  const bell = watch(`${file}.bell`, { persistent: false }, () => {
    if (!armed) return;
    armed = false;
    // Due at the very next timers phase: after the waiter's refused attempt, before the loop polls again.
    setTimeout(() => holder.release(held.reservation.token), 0);
    const due = performance.now() + 5;
    while (performance.now() < due) { /* let the timer come due within this turn */ }
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = performance.now();
  writeFileSync(`${file}.bell`, 'a wake-up with the slot still taken');
  try {
    await expect(waiting).resolves.toMatchObject({ allowed: true });
    expect(performance.now() - started).toBeLessThan(1000);
  } finally { bell.close(); }
});
