import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';
const dirs: string[] = [], ledgers: HostLedger[] = [], children: ChildProcess[] = [];
function path() { const d = mkdtempSync(join(tmpdir(), 'oar-host-wait-')); dirs.push(d); return join(d, 'ledger.sqlite'); }
function open(databasePath = path(), quotaCooldownMs = 80) {
  const l = new HostLedger({ databasePath, providers: { claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs } }, busyTimeoutMs: 1000 });
  ledgers.push(l); return l;
}
function held(l: HostLedger) { const r = l.reserve('claude', 'holder'); if (!r.allowed) throw Error(r.reason); return r.reservation.token; }
function child(file: string, mode: string) {
  const c = fork(fileURLToPath(new URL('./budget-fixtures/host-worker.ts', import.meta.url)), [file, mode], { execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(c); return c;
}
function message(c: ChildProcess) { return new Promise<unknown>((resolve, reject) => { c.once('message', resolve); c.once('error', reject); c.once('exit', code => { if (code !== 0) reject(Error(`child exit ${code}`)); }); }); }
afterEach(() => { children.splice(0).forEach(c => c.kill()); ledgers.splice(0).forEach(l => l.close()); vi.restoreAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

test('another instance release wakes a waiter promptly', async () => {
  const file = path(), first = open(file), token = held(first), second = open(file);
  const started = performance.now(), waiting = second.acquire('claude', 'waiter', { maxWaitMs: 3000 });
  setTimeout(() => first.release(token), 40);
  await expect(waiting).resolves.toMatchObject({ allowed: true }); expect(performance.now() - started).toBeLessThan(1000);
});

test('separate processes share counters and ring on release', async () => {
  const file = path(), holder = child(file, 'hold'); await message(holder);
  const ledger = open(file);
  expect(ledger.reserve('claude', 'immediate')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  const started = performance.now(), waiting = ledger.acquire('claude', 'waiting', { maxWaitMs: 3000 }); holder.send('release');
  await expect(waiting).resolves.toMatchObject({ allowed: true }); expect(performance.now() - started).toBeLessThan(1000);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 2 } });
});

test('lost bell uses a bounded deadline and never grants late or busy polls', async () => {
  const file = path(), ledger = open(file), token = held(ledger);
  // Remove the bell before arming, then release without a notification.
  rmSync(`${file}.bell`, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE attempts(n INTEGER); CREATE TRIGGER count_attempts AFTER UPDATE OF last_observed_at ON budget_providers BEGIN INSERT INTO attempts VALUES(1); END;`);
  const waiting = ledger.acquire('claude', 'late', { maxWaitMs: 55 });
  // The waiter attempts once its watch is surely listening, two loop turns later; release after that attempt.
  await new Promise<void>(resolve => { setImmediate(resolve); });
  await new Promise<void>(resolve => { setImmediate(resolve); });
  db.prepare('UPDATE budget_reservations SET released = 1 WHERE token = ?').run(token);
  const started = performance.now();
  await expect(waiting).resolves.toMatchObject({ allowed: false, reason: 'wait-timeout' });
  expect(performance.now() - started).toBeLessThan(500);
  expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.n).toBe(1); db.close();
  ledger.release(token);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { launchesLastDay: 1 } });
});

test('abort reason and close remove wait resources without consuming admission', async () => {
  const ledger = open(), controller = new AbortController(); held(ledger);
  const reason = { stopped: true }, waiting = ledger.acquire('claude', 'aborted', { maxWaitMs: 30_000, signal: controller.signal });
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  controller.abort(reason); await expect(waiting).rejects.toBe(reason);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { launchesLastDay: 1 } });
  const closed = ledger.acquire('claude', 'closed', { maxWaitMs: 30_000 }); ledger.close();
  await expect(closed).resolves.toMatchObject({ allowed: false, reason: 'closed' });
  const preAborted = new AbortController(); preAborted.abort(reason);
  await expect(open().acquire('claude', 'abort', { maxWaitMs: 0, signal: preAborted.signal })).rejects.toBe(reason);
});

test('maxWait zero is exactly one immediate attempt and unknown/hourly denials do not queue', async () => {
  const ledger = open(); held(ledger);
  await expect(ledger.acquire('claude', 'now', { maxWaitMs: 0 })).resolves.toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  await expect(ledger.acquire('unknown', 'now', { maxWaitMs: 30_000 })).resolves.toMatchObject({ allowed: false, reason: 'unknown-provider' });
  const disabled = new HostLedger({ databasePath: path(), providers: { claude: { concurrency: { mode: 'unlimited' }, maxLaunchesPerHour: 0, maxLaunchesPerDay: 1, quotaCooldownMs: 1 } } }); ledgers.push(disabled);
  await expect(disabled.acquire('claude', 'now', { maxWaitMs: 30_000 })).resolves.toMatchObject({ allowed: false, reason: 'hourly-limit' });
});

test('quota cooldown wakes at its expiry and remains bounded by the monotonic deadline', async () => {
  const ledger = open(); ledger.recordQuotaError('claude');
  await expect(ledger.acquire('claude', 'ok', { maxWaitMs: 1000 })).resolves.toMatchObject({ allowed: true });
  const other = open(); other.recordQuotaError('claude');
  await expect(other.acquire('claude', 'late', { maxWaitMs: 20 })).resolves.toMatchObject({ allowed: false, reason: 'wait-timeout' });
  expect(other.status('claude')).toMatchObject({ ok: true, status: { launchesLastDay: 0 } });
});

test('positive admission deadline is rechecked inside the transaction after a SQLite lock wait', async () => {
  const file = path(), ledger = open(file), locker = child(file, 'lock');
  await message(locker);
  const result = await ledger.acquire('claude', 'late', { maxWaitMs: 30 });
  expect(result).toMatchObject({ allowed: false, reason: 'wait-timeout' });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 0 } });
});

test('wait option validation cannot consume a launch', async () => {
  const ledger = open();
  for (const options of [{ maxWaitMs: -1 }, { maxWaitMs: Infinity }, { maxWaitMs: 0.5 }, { maxWaitMs: 1, extra: true }]) {
    await expect(ledger.acquire('claude', 'invalid', options as never)).rejects.toThrow(TypeError);
  }
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { launchesLastDay: 0 } });
});

test('exhausted launch windows never queue behind concurrency or cooldown denials', async () => {
  for (const ceiling of ['maxLaunchesPerHour', 'maxLaunchesPerDay'] as const) {
    const ledger = new HostLedger({ databasePath: path(), providers: { claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 1000, [ceiling]: 1 } } }); ledgers.push(ledger);
    held(ledger); ledger.recordQuotaError('claude');
    const start = performance.now();
    await expect(ledger.acquire('claude', 'cannot-launch', { maxWaitMs: 200 })).resolves.toMatchObject({ allowed: false, reason: ceiling === 'maxLaunchesPerHour' ? 'hourly-limit' : 'daily-limit' });
    expect(performance.now() - start).toBeLessThan(100);
  }
});

test('a positive deadline already expired before the first attempt consumes no launch', async () => {
  const { performance: monotonic } = await import('node:perf_hooks');
  const ledger = open(); let calls = 0;
  vi.spyOn(monotonic, 'now').mockImplementation(() => calls++ === 0 ? 100 : 102);
  await expect(ledger.acquire('claude', 'late-before-attempt', { maxWaitMs: 1 })).resolves.toMatchObject({ allowed: false, reason: 'wait-timeout' });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { launchesLastDay: 0 } });
});

test('a disabled concurrency policy does not queue even while quota cooldown is active', async () => {
  const ledger = new HostLedger({ databasePath: path(), concurrency: { mode: 'limited', maxConcurrent: 0 } }); ledgers.push(ledger);
  ledger.recordQuotaError('claude');
  const started = performance.now();
  await expect(ledger.acquire('claude', 'disabled', { maxWaitMs: 150 })).resolves.toMatchObject({ allowed: false, reason: 'quota-cooldown' });
  expect(performance.now() - started).toBeLessThan(100);
});

test('mutating queued maxWaitMs cannot disable the original admission deadline', async () => {
  const { performance: monotonic } = await import('node:perf_hooks');
  let now = 100; vi.spyOn(monotonic, 'now').mockImplementation(() => now);
  const ledger = open(), token = held(ledger), options = { maxWaitMs: 50 };
  const work = ledger.acquire('claude', 'deadline-snapshot', options);
  options.maxWaitMs = 0; now = 151; ledger.release(token);
  await expect(work).resolves.toMatchObject({ allowed: false, reason: 'wait-timeout' });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
});

test('replacing a queued signal cannot replace the original cancellation binding', async () => {
  const ledger = open(), token = held(ledger), original = new AbortController(), replacement = new AbortController();
  const options = { maxWaitMs: 1000, signal: original.signal }, reason = { wrong: 'replacement' };
  const work = ledger.acquire('claude', 'signal-snapshot', options);
  replacement.abort(reason); options.signal = replacement.signal; setTimeout(() => ledger.release(token), 40);
  await expect(work).resolves.toMatchObject({ allowed: true });
  expect(getEventListeners(original.signal, 'abort')).toHaveLength(0);
  expect(getEventListeners(replacement.signal, 'abort')).toHaveLength(0);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 2 } });
});
