import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { HostLedger, WAITER_LEASE_MS } from '../../src/orchestration/budget/host-ledger.ts';
import { canaryLastAttempt, freeSilently, jumps, ledgerProcess, ring, stillPending, until, waiting, witnessJumps } from './budget-fixtures/priority-probe.ts';

const dirs: string[] = [];
const ledgers: HostLedger[] = [];
const children: ChildProcess[] = [];

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oar-host-priority-'));
  dirs.push(directory);
  return join(directory, 'ledger.sqlite');
}

/** Every call is a separate connection to the same file, as a separate app would hold. */
function open(databasePath: string, maxConcurrent = 1, quotaCooldownMs = 80): HostLedger {
  const ledger = new HostLedger({
    databasePath,
    providers: {
      claude: { concurrency: { mode: 'limited', maxConcurrent }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs },
    },
    busyTimeoutMs: 1000,
  });
  ledgers.push(ledger);
  return ledger;
}

function hold(ledger: HostLedger, owner = 'holder'): string {
  const admission = ledger.reserve('claude', owner);
  if (!admission.allowed) throw new Error(admission.reason);
  return admission.reservation.token;
}

function activeOwners(ledger: HostLedger): string[] {
  const result = ledger.status('claude');
  if (!result.ok) throw new Error(result.reason);
  return result.status.reservations.map(reservation => reservation.owner);
}

afterEach(() => {
  children.splice(0).forEach(child => child.kill('SIGKILL'));
  ledgers.splice(0).forEach(ledger => ledger.close());
  dirs.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

/**
 * The slot is freed and the bell rung while the production process is held still, so the canary is
 * certain to try first. Returns once the canary has made that attempt, or has stopped waiting.
 */
async function freeSlotWithOnlyTheCanaryAwake(file: string, token: string): Promise<void> {
  freeSilently(file, token);
  const before = canaryLastAttempt(file);
  // Attempt times are whole milliseconds: let the clock move so a new attempt is distinguishable.
  await new Promise(resolve => setTimeout(resolve, 5));
  ring(file);
  await until(() => canaryLastAttempt(file) !== before, 'the canary to try for the free slot');
}

test('with the quota full the canary waits, and a production run that arrives later is admitted first', async () => {
  const file = path();
  const holder = open(file), canary = open(file);
  witnessJumps(file);
  for (let round = 0; round < 3; round += 1) {
    const token = hold(holder);
    const canaryRun = canary.acquire('claude', `canary:${round}`, { maxWaitMs: 60_000, priority: 'low' });
    await until(() => waiting(file).length === 1, 'the canary to be waiting');

    // Production arrives later, from its own process, and is then held still: it stays declared
    // but cannot race. Whatever the canary does next is decided by the rule and not by wake order.
    const production = ledgerProcess(file, `production-${round}`, 'normal', children);
    await until(() => production.check() && waiting(file).length === 2, 'the production run to be waiting');
    await production.stall();

    await freeSlotWithOnlyTheCanaryAwake(file, token);
    expect(await stillPending(canaryRun, 50)).toBe(true);
    expect(activeOwners(holder)).toEqual([]);
    expect(waiting(file).map(waiter => waiter.priority)).toEqual([0, 1]);

    production.resume();
    ring(file);
    await until(() => production.check() && production.admitted(), 'the production run to be admitted');
    expect(await stillPending(canaryRun)).toBe(true);
    expect(activeOwners(holder)).toEqual([`production-${round}`]);

    production.finish();
    const late = await canaryRun;
    if (!late.allowed) throw new Error(late.reason);
    expect(activeOwners(holder)).toEqual([`canary:${round}`]);
    canary.release(late.reservation.token);
    await until(() => waiting(file).length === 0, 'the queue to empty');
  }
  expect(jumps(file)).toEqual([]);
}, 90_000);

test('a canary does not take a free slot that a production waiter is waiting for', async () => {
  const file = path();
  const holder = open(file), canary = open(file), production = open(file);
  const token = hold(holder);
  const productionRun = production.acquire('claude', 'production', { maxWaitMs: 8000 });
  await until(() => waiting(file).length === 1, 'the production run to be waiting');

  // Free the slot behind the ledger's back: no bell rings, so the production waiter is still asleep.
  freeSilently(file, token);
  expect(activeOwners(holder)).toEqual([]);

  const immediate = canary.reserve('claude', 'canary', 'low');
  expect(immediate).toMatchObject({ allowed: false, reason: 'concurrency-limit', outranked: true });
  await expect(canary.acquire('claude', 'canary', { maxWaitMs: 0, priority: 'low' })).resolves.toMatchObject({ allowed: false, outranked: true });
  const waitingCanary = canary.acquire('claude', 'canary', { maxWaitMs: 8000, priority: 'low' });
  expect(await stillPending(waitingCanary)).toBe(true);
  expect(activeOwners(holder)).toEqual([]);

  ring(file);
  const admitted = await productionRun;
  if (!admitted.allowed) throw new Error(admitted.reason);
  expect(activeOwners(holder)).toEqual(['production']);
  production.release(admitted.reservation.token);
  await expect(waitingCanary).resolves.toMatchObject({ allowed: true });
});

test('callers that pass no priority keep today\'s behaviour, and a lone canary is admitted at once', async () => {
  const file = path();
  const first = open(file), second = open(file);
  const token = hold(first);
  expect(second.reserve('claude', 'other')).toEqual({ allowed: false, reason: 'concurrency-limit' });
  expect(second.reserve('claude', 'other', 'normal')).toEqual({ allowed: false, reason: 'concurrency-limit' });
  expect(second.reserve('claude', 'canary', 'low')).toEqual({ allowed: false, reason: 'concurrency-limit' });
  await expect(second.acquire('claude', 'other', { maxWaitMs: 0 })).resolves.toEqual({ allowed: false, reason: 'concurrency-limit' });
  await expect(second.acquire('claude', 'other', { maxWaitMs: 40 })).resolves.toEqual({ allowed: false, reason: 'wait-timeout' });
  first.release(token);

  const canary = second.reserve('claude', 'canary', 'low');
  expect(canary).toMatchObject({ allowed: true, reservation: { owner: 'canary', providerKey: 'claude' } });
  if (!canary.allowed) throw new Error(canary.reason);
  second.release(canary.reservation.token);
  const waited = await second.acquire('claude', 'canary', { maxWaitMs: 1000, priority: 'low' });
  expect(waited).toMatchObject({ allowed: true });
  expect(waiting(file)).toEqual([]);
});

test('a known limit: a production caller that does not wait is not declared and has no precedence', async () => {
  const file = path();
  const holder = open(file), canary = open(file), production = open(file);
  const token = hold(holder);
  const canaryRun = canary.acquire('claude', 'canary', { maxWaitMs: 8000, priority: 'low' });
  await until(() => waiting(file).length === 1, 'the canary to be waiting');

  // One immediate attempt, as an app that stops on refusal makes it.
  expect(production.reserve('claude', 'production')).toEqual({ allowed: false, reason: 'concurrency-limit' });
  await expect(production.acquire('claude', 'production', { maxWaitMs: 0 })).resolves.toEqual({ allowed: false, reason: 'concurrency-limit' });
  expect(waiting(file).map(waiter => waiter.priority)).toEqual([0]);

  holder.release(token);
  await expect(canaryRun).resolves.toMatchObject({ allowed: true });
  expect(production.reserve('claude', 'production')).toEqual({ allowed: false, reason: 'concurrency-limit' });
});

test('a production waiter that gives up stops outranking, and the canary is woken promptly', async () => {
  const file = path();
  const holder = open(file), canary = open(file), production = open(file);
  const token = hold(holder);
  const controller = new AbortController();
  const productionRun = production.acquire('claude', 'production', { maxWaitMs: 8000, signal: controller.signal });
  await until(() => waiting(file).length === 1, 'the production run to be waiting');

  freeSilently(file, token);
  const canaryRun = canary.acquire('claude', 'canary', { maxWaitMs: 8000, priority: 'low' });
  expect(await stillPending(canaryRun)).toBe(true);

  const started = performance.now();
  controller.abort(new Error('operator cancelled'));
  await expect(productionRun).rejects.toThrow('operator cancelled');
  await expect(canaryRun).resolves.toMatchObject({ allowed: true });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(waiting(file)).toEqual([]);
});

test('closing a ledger withdraws its waiting production run', async () => {
  const file = path();
  const holder = open(file), canary = open(file), production = open(file);
  hold(holder);
  const productionRun = production.acquire('claude', 'production', { maxWaitMs: 8000 });
  await until(() => waiting(file).length === 1, 'the production run to be waiting');
  production.close();
  await expect(productionRun).resolves.toMatchObject({ allowed: false, reason: 'closed' });
  expect(waiting(file)).toEqual([]);
  expect(canary.reserve('claude', 'canary', 'low')).toEqual({ allowed: false, reason: 'concurrency-limit' });
});

test('a production waiter whose process died stops outranking once its lease lapses', async () => {
  const file = path();
  const canary = open(file);
  expect(canary.status('claude').ok).toBe(true);
  expect(canary.reserve('claude', 'probe', 'low').allowed).toBe(true);
  const raw = new DatabaseSync(file);
  const insert = raw.prepare('INSERT INTO budget_waiters(waiter, provider_key, priority, seen_at) VALUES (?, ?, 1, ?)');
  insert.run('dead-production', 'claude', Date.now() - WAITER_LEASE_MS - 1);
  insert.run('live-production', 'claude', Date.now());
  raw.close();

  // Capacity is one and the probe holds it, so free it and look at who is entitled to the slot.
  const probe = canary.status('claude');
  if (!probe.ok) throw new Error(probe.reason);
  canary.release(probe.status.reservations[0]!.token);
  expect(canary.reserve('claude', 'canary', 'low')).toMatchObject({ allowed: false, outranked: true });

  const again = new DatabaseSync(file);
  again.prepare("DELETE FROM budget_waiters WHERE waiter = 'live-production'").run();
  again.close();
  expect(canary.reserve('claude', 'canary', 'low')).toMatchObject({ allowed: true });
  expect(WAITER_LEASE_MS).toBeGreaterThanOrEqual(60_000);
});

test('when two slots free together the production run and then the canary are both admitted without a long wait', async () => {
  const file = path();
  const holder = open(file, 2), canary = open(file, 2), production = open(file, 2);
  const tokens = [hold(holder, 'holder-a'), hold(holder, 'holder-b')];
  const canaryRun = canary.acquire('claude', 'canary', { maxWaitMs: 8000, priority: 'low' });
  await until(() => waiting(file).length === 1, 'the canary to be waiting');
  const productionRun = production.acquire('claude', 'production', { maxWaitMs: 8000 });
  await until(() => waiting(file).length === 2, 'the production run to be waiting');

  const started = performance.now();
  tokens.forEach(token => holder.release(token));
  await expect(productionRun).resolves.toMatchObject({ allowed: true });
  await expect(canaryRun).resolves.toMatchObject({ allowed: true });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(activeOwners(holder).sort()).toEqual(['canary', 'production']);
});

test('after an observed quota pause the production run goes first too', async () => {
  const file = path();
  const holder = open(file, 1, 300), canary = open(file, 1, 300), production = open(file, 1, 300);
  expect(holder.recordQuotaError('claude').ok).toBe(true);
  const order: string[] = [];
  const canaryRun = canary.acquire('claude', 'canary', { maxWaitMs: 8000, priority: 'low' });
  void canaryRun.then(() => order.push('canary'));
  await until(() => waiting(file).length === 1, 'the canary to be waiting');
  const productionRun = production.acquire('claude', 'production', { maxWaitMs: 8000 });
  void productionRun.then(() => order.push('production'));
  await until(() => waiting(file).length === 2, 'the production run to be waiting');

  const admitted = await productionRun;
  if (!admitted.allowed) throw new Error(admitted.reason);
  expect(await stillPending(canaryRun)).toBe(true);
  production.release(admitted.reservation.token);
  await expect(canaryRun).resolves.toMatchObject({ allowed: true });
  expect(order).toEqual(['production', 'canary']);
});

test('withSlot carries the priority and an unknown priority is refused before any wait', async () => {
  const file = path();
  const ledger = open(file);
  await expect(ledger.withSlot('claude', 'canary', { maxWaitMs: 500, priority: 'low' }, async () => activeOwners(ledger))).resolves.toEqual(['canary']);
  await expect(ledger.acquire('claude', 'x', { maxWaitMs: 10, priority: 'urgent' as never })).rejects.toThrow(TypeError);
  await expect(ledger.withSlot('claude', 'x', { maxWaitMs: 10, priority: 7 as never }, async () => 1)).rejects.toThrow(TypeError);
  expect(ledger.reserve('claude', 'x', 'urgent' as never)).toMatchObject({ allowed: false, reason: 'invalid-input' });
  expect(activeOwners(ledger)).toEqual([]);
});

test('the rule holds between separate processes sharing one ledger file', async () => {
  const file = path();
  const holder = open(file);
  witnessJumps(file);
  const token = hold(holder);

  const canary = ledgerProcess(file, 'canary', 'low', children);
  await until(() => canary.check() && waiting(file).length === 1, 'the canary process to be waiting');
  const production = ledgerProcess(file, 'production', 'normal', children);
  await until(() => production.check() && waiting(file).length === 2, 'the production process to be waiting');
  await production.stall();

  // Only the canary process can react to the free slot, and it leaves it alone.
  await freeSlotWithOnlyTheCanaryAwake(file, token);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(canary.check() && canary.admitted()).toBe(false);
  expect(activeOwners(holder)).toEqual([]);
  expect(waiting(file).map(waiter => waiter.priority)).toEqual([0, 1]);

  production.resume();
  ring(file);
  await until(() => production.check() && production.admitted(), 'the production process to be admitted');
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(canary.check() && canary.admitted()).toBe(false);
  expect(activeOwners(holder)).toEqual(['production']);

  production.finish();
  await until(() => canary.check() && canary.admitted(), 'the canary process to be admitted');
  expect(activeOwners(holder)).toEqual(['canary']);
  canary.finish();
  await until(() => canary.check() && production.check() && activeOwners(holder).length === 0, 'both processes to finish');
  expect(jumps(file)).toEqual([]);
}, 60_000);
