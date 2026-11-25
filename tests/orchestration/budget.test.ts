import { mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { SharedLaunchBudget, type LaunchBudgetLimits } from '../../src/orchestration/budget/index.ts';
import { reserveAndCrash } from './budget-fixtures/measure.ts';

const LIMITS = { maxConcurrent: 2, maxLaunchesPerHour: 3, maxLaunchesPerDay: 4, quotaCooldownMs: 60_000 };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const dirs: string[] = [];
const budgets: SharedLaunchBudget[] = [];
function ledger() { const dir = mkdtempSync(join(tmpdir(), 'oar-budget-')); dirs.push(dir); return join(dir, 'budget.db'); }
function open(databasePath = ledger(), providers: Record<string, LaunchBudgetLimits> = { 'claude:personal': LIMITS }, busyTimeoutMs = 10) {
  const budget = new SharedLaunchBudget({ databasePath, providers, busyTimeoutMs }); budgets.push(budget); return budget;
}
function reserve(budget: SharedLaunchBudget, key = 'claude:personal') {
  const result = budget.reserve(key, 'test-owner');
  expect(result.allowed).toBe(true);
  if (!result.allowed) throw new Error(JSON.stringify(result));
  return result.reservation;
}
afterEach(() => {
  budgets.splice(0).forEach(budget => budget.close()); vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

test('charges at admission, releases only concurrency, and preserves outstanding reservations when reopened', () => {
  const path = ledger(); const first = open(path);
  const a = reserve(first); const b = reserve(first);
  expect(first.reserve('claude:personal', 'third')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  expect(first.release(a.token)).toEqual({ ok: true, released: true });
  expect(first.release(a.token)).toEqual({ ok: true, released: false });
  first.close();
  const second = open(path);
  expect(second.status('claude:personal')).toMatchObject({ ok: true, status: {
    active: 1, launchesLastHour: 2, launchesLastDay: 2, reservations: [{ token: b.token }],
  } });
  const c = reserve(second); second.release(c.token); second.release(b.token);
  expect(second.reserve('claude:personal', 'fourth')).toMatchObject({ allowed: false, reason: 'hourly-limit' });
  expect(second.status('claude:personal')).toMatchObject({ ok: true, status: { active: 0, launchesLastHour: 3 } });
});

test('enforces rolling hour and day boundaries rather than resetting on calendar dates', () => {
  let now = 86_399_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budget = open();
  for (let i = 0; i < 3; i++) budget.release(reserve(budget).token);
  now += 2_000;
  expect(budget.reserve('claude:personal', 'midnight')).toMatchObject({ allowed: false, reason: 'hourly-limit' });
  now = 86_399_000 + HOUR;
  budget.release(reserve(budget).token);
  now += HOUR;
  expect(budget.reserve('claude:personal', 'fifth')).toMatchObject({ allowed: false, reason: 'daily-limit' });
  now = 86_399_000 + DAY;
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { launchesLastHour: 0, launchesLastDay: 1 } });
  reserve(budget);
});

test('an explicitly observed quota error persists a cooldown for only that provider/account', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const path = ledger();
  const providers = { 'claude:personal': LIMITS, 'claude:work': LIMITS, 'codex:personal': LIMITS };
  const first = open(path, providers);
  expect(first.recordQuotaError('claude:personal')).toEqual({ ok: true, pausedUntil: 1_060_000 });
  first.close(); const budget = open(path, providers);
  expect(budget.reserve('claude:personal', 'blocked')).toMatchObject({ allowed: false, reason: 'quota-cooldown', retryAt: 1_060_000 });
  reserve(budget, 'claude:work'); reserve(budget, 'codex:personal');
  now += 60_000; reserve(budget);
});

test('unknown providers and different configurations cannot obtain a fresh or larger budget', () => {
  const path = ledger(); const first = open(path); reserve(first);
  expect(first.reserve('unknown', 'owner')).toMatchObject({ allowed: false, reason: 'unknown-provider' });
  const mismatch = open(path, { 'claude:personal': { ...LIMITS, maxConcurrent: 30 } });
  expect(mismatch.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'configuration-mismatch' });
  expect(mismatch.recordQuotaError('claude:personal')).toMatchObject({ ok: false, reason: 'configuration-mismatch' });
  expect(first.status('claude:personal')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined])('rejects invalid numeric limits (%s) before opening storage', value => {
  expect(() => open(ledger(), { 'claude:personal': { ...LIMITS, maxConcurrent: value as number } })).toThrow(TypeError);
});

test('requires an absolute persistent path and every limit; zero launch ceilings deny', () => {
  expect(() => open('relative.db')).toThrow(TypeError);
  expect(() => open(':memory:')).toThrow(TypeError);
  expect(() => open(ledger(), { 'claude:personal': { maxConcurrent: 1 } as typeof LIMITS })).toThrow(TypeError);
  expect(() => open(ledger(), { 'claude:personal': { ...LIMITS, quotaCooldownMs: 0 } })).toThrow(TypeError);
  const budget = open(ledger(), { 'claude:personal': { ...LIMITS, maxLaunchesPerDay: 0 } });
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'daily-limit' });
});

test('explicit invalid lock wait and other numeric limits never fall back to a permissive default', () => {
  for (const value of [null, NaN, Infinity, -1, 0.5, 60_001]) {
    expect(() => open(ledger(), undefined, value as number)).toThrow(TypeError);
  }
  for (const field of ['maxLaunchesPerHour', 'maxLaunchesPerDay', 'quotaCooldownMs'] as const) {
    expect(() => open(ledger(), { 'claude:personal': { ...LIMITS, [field]: NaN } })).toThrow(TypeError);
  }
});

test('unreadable, corrupt and locked storage denies both admission and status rather than showing zero usage', () => {
  const path = ledger(); writeFileSync(path, 'not a sqlite database'); const corrupt = open(path);
  expect(corrupt.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
  expect(corrupt.status('claude:personal')).toMatchObject({ ok: false, reason: 'storage-unavailable' });
  const otherPath = ledger(); const budget = open(otherPath); reserve(budget);
  const locker = new DatabaseSync(otherPath); locker.exec('BEGIN EXCLUSIVE');
  try {
    expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
    expect(budget.status('claude:personal')).toMatchObject({ ok: false, reason: 'storage-unavailable' });
  } finally { locker.exec('ROLLBACK'); locker.close(); }
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
  const missingParent = open(join(ledger(), 'child.db'));
  expect(missingParent.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
});

test('clock rollback denies admission without refunding earlier launches', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budget = open(); budget.release(reserve(budget).token); now--;
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'clock-rollback' });
  now++;
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { launchesLastHour: 1 } });
});

test('a valid SQLite file with corrupt rows or an unknown schema never becomes a fresh budget', () => {
  const path = ledger(); const budget = open(path); reserve(budget);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA ignore_check_constraints = ON; UPDATE budget_reservations SET released = 2');
  db.close();
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
  expect(open(path).status('claude:personal')).toMatchObject({ ok: false, reason: 'storage-unavailable' });
  const unrelatedPath = ledger(); const unrelated = new DatabaseSync(unrelatedPath);
  unrelated.exec('CREATE TABLE unrelated(value TEXT)'); unrelated.close();
  expect(open(unrelatedPath).reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
});

test('reopening a truncated existing ledger never erases an outstanding reservation or launch debit', () => {
  const path = ledger();
  const providers = { 'claude:personal': { ...LIMITS, maxConcurrent: 1, maxLaunchesPerHour: 1, maxLaunchesPerDay: 1 } };
  const first = open(path, providers); reserve(first); first.close();
  truncateSync(path, 0);
  const reopened = open(path, providers);
  expect(reopened.reserve('claude:personal', 'second')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
  expect(reopened.status('claude:personal')).toMatchObject({ ok: false, reason: 'storage-unavailable' });
});

test('pre-existing empty files and empty SQLite databases require explicit recovery', () => {
  const emptyFile = ledger(); writeFileSync(emptyFile, '');
  expect(open(emptyFile).reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
  const emptyDatabase = ledger(); const db = new DatabaseSync(emptyDatabase); db.exec('VACUUM'); db.close();
  expect(open(emptyDatabase).reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
});

test('a replaced database and a closed instance cannot admit or show a fresh allowance', () => {
  const path = ledger(); const budget = open(path); reserve(budget);
  renameSync(path, `${path}.old`);
  const replacement = open(path); reserve(replacement);
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'storage-unavailable' });
  budget.close();
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'closed' });
});

test('a killed worker keeps its reservation until explicit recovery, even after a whole day', async () => {
  const path = ledger(); const token = await reserveAndCrash(path);
  const budget = open(path, { 'test:account': { maxConcurrent: 1, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 60_000 } });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DAY * 2);
  expect(budget.reserve('test:account', 'replacement')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  expect(budget.release(token)).toEqual({ ok: true, released: true });
  reserve(budget, 'test:account');
}, 20_000);

test('a ledger locked during construction recovers after unlock without forgetting existing reservations', () => {
 const path=ledger();const first=open(path,{'claude:personal':{...LIMITS,maxConcurrent:1}});const held=reserve(first);
 const locker=new DatabaseSync(path);locker.exec('BEGIN EXCLUSIVE');
 const waiting=open(path,{'claude:personal':{...LIMITS,maxConcurrent:1}},0);
 try {expect(waiting.reserve('claude:personal','blocked')).toMatchObject({allowed:false,reason:'storage-unavailable'});}
 finally {locker.exec('ROLLBACK');locker.close();}
 expect(waiting.reserve('claude:personal','second')).toMatchObject({allowed:false,reason:'concurrency-limit'});
 expect(waiting.status('claude:personal')).toMatchObject({ok:true,status:{active:1,launchesLastDay:1}});
 expect(waiting.release(held.token)).toMatchObject({ok:true,released:true});
 expect(waiting.reserve('claude:personal','after-recovery').allowed).toBe(true);
});

test('a ledger replaced after a locked construction never silently adopts the new allowance', () => {
 const path=ledger();open(path);const locker=new DatabaseSync(path);locker.exec('BEGIN EXCLUSIVE');
 const waiting=open(path,undefined,0);locker.exec('ROLLBACK');locker.close();
 renameSync(path,`${path}.locked-original`);open(path);
 expect(waiting.reserve('claude:personal','replacement')).toMatchObject({allowed:false,reason:'storage-unavailable'});
});

test('status() never advances the observed clock, so an idle app under a forward clock does not poison the ledger', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budget = open(); budget.release(reserve(budget).token);
  now = 1_000_000 + DAY * 7; // The operator advanced the date to look at next week; the app only polled status.
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { launchesLastDay: 0 } });
  now = 1_000_001;
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { launchesLastHour: 1 } });
  reserve(budget);
});

test('a launch under a forward clock denies later admission with the time it clears; status compares without writing', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budget = open(); reserve(budget);
  now = 1_000_000 + DAY * 7; budget.release(reserve(budget).token);
  now = 1_000_000;
  const retryAt = 1_000_000 + DAY * 7;
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'clock-rollback', retryAt });
  expect(budget.status('claude:personal')).toMatchObject({ ok: false, reason: 'clock-rollback', retryAt });
  expect(budget.recordQuotaError('claude:personal')).toMatchObject({ ok: false, reason: 'clock-rollback', retryAt });
  now = retryAt;
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { active: 1, launchesLastHour: 1, launchesLastDay: 1 } });
});

test('acknowledgeClock restores admission without refunding anything and audits itself in the ledger', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const path = ledger(); const budget = open(path);
  now = 1_000_000 + DAY * 7; const held = reserve(budget); budget.release(reserve(budget).token);
  now = 1_000_000;
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'clock-rollback' });
  for (const acknowledgement of [undefined, {}, { operatorConfirmed: false }, { operatorConfirmed: 'yes' }]) {
    expect(budget.acknowledgeClock('claude:personal', acknowledgement as never)).toMatchObject({ ok: false, reason: 'invalid-input' });
  }
  expect(budget.acknowledgeClock('unknown', { operatorConfirmed: true })).toMatchObject({ ok: false, reason: 'unknown-provider' });
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'clock-rollback' });
  expect(budget.acknowledgeClock('claude:personal', { operatorConfirmed: true }))
    .toEqual({ ok: true, previousObservedAt: 1_000_000 + DAY * 7, acknowledgedAt: 1_000_000 });
  // Conservative: the future-dated launches still count and the active reservation remains held.
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: {
    active: 1, launchesLastHour: 2, launchesLastDay: 2, reservations: [{ token: held.token }],
  } });
  reserve(budget);
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT provider_key, previous_observed_at, acknowledged_at FROM budget_clock_acknowledgements').all();
  db.close();
  expect(rows).toEqual([{ provider_key: 'claude:personal', previous_observed_at: 1_000_000 + DAY * 7, acknowledged_at: 1_000_000 }]);
});

test('a ledger created before the acknowledgement audit table accepts acknowledgeClock without a schema bump', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const path = ledger(); const first = open(path); reserve(first); first.close();
  const db = new DatabaseSync(path); db.exec('DROP TABLE budget_clock_acknowledgements'); db.close();
  const budget = open(path); now = 999_000;
  expect(budget.reserve('claude:personal', 'owner')).toMatchObject({ allowed: false, reason: 'clock-rollback', retryAt: 1_000_000 });
  expect(budget.acknowledgeClock('claude:personal', { operatorConfirmed: true })).toMatchObject({ ok: true, previousObservedAt: 1_000_000, acknowledgedAt: 999_000 });
  expect(budget.status('claude:personal')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
  expect(open(path).status('claude:personal')).toMatchObject({ ok: true, status: { active: 1 } });
});

test('status() of a provider never reserved under a forward clock does not stamp the clock, so it admits once the clock returns', () => {
  const providers = { claude: LIMITS, codex: LIMITS };
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budget = open(ledger(), providers); budget.release(reserve(budget, 'claude').token);
  now = 1_000_000 + DAY * 3; // The operator moved the date forward; the app snapshot reads every provider.
  expect(budget.status('claude')).toMatchObject({ ok: true });
  expect(budget.status('codex')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 0 } });
  now = 1_000_000 + 1_000;
  expect(budget.status('codex')).toMatchObject({ ok: true, status: { active: 0 } });
  reserve(budget, 'codex'); reserve(budget, 'claude');
});
