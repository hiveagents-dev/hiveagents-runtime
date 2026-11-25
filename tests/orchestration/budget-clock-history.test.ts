import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { SharedLaunchBudget } from '../../src/orchestration/budget/index.ts';

const DAY = 86_400_000, BASE = 10 * DAY;
const LIMITS = { maxConcurrent: 3, maxLaunchesPerHour: 3, maxLaunchesPerDay: 3, quotaCooldownMs: 60_000 };
const directories: string[] = [], budgets: SharedLaunchBudget[] = [], connections: DatabaseSync[] = [];
function path() { const dir = mkdtempSync(join(tmpdir(), 'oar-clock-history-')); directories.push(dir); return join(dir, 'budget.sqlite'); }
function open(databasePath: string) { const budget = new SharedLaunchBudget({ databasePath, providers: { claude: LIMITS } }); budgets.push(budget); return budget; }
function db(databasePath: string) { const connection = new DatabaseSync(databasePath); connections.push(connection); return connection; }
function reserve(budget: SharedLaunchBudget) {
  const value = budget.reserve('claude', 'synthetic'); expect(value.allowed).toBe(true);
  if (!value.allowed) throw Error(JSON.stringify(value)); return value.reservation;
}
function clock(initial = BASE) { let now = initial; vi.spyOn(Date, 'now').mockImplementation(() => now); return (value: number) => { now = value; }; }
function pruned() {
  const setTime = clock(), databasePath = path(), budget = open(databasePath);
  for (let i = 0; i < 3; i++) budget.release(reserve(budget).token);
  setTime(BASE + 7 * DAY); budget.release(reserve(budget).token);
  setTime(BASE); return { setTime, databasePath, budget };
}
afterEach(() => {
  connections.splice(0).forEach(connection => connection.close()); budgets.splice(0).forEach(budget => budget.close());
  vi.restoreAllMocks(); directories.splice(0).forEach(dir => rmSync(dir, { force: true, recursive: true }));
});

test('clock acknowledgement cannot refund launches deleted under a future clock', () => {
  const { budget } = pruned();
  expect(budget.acknowledgeClock('claude', { operatorConfirmed: true }))
    .toMatchObject({ ok: false, reason: 'clock-rollback', retryAt: BASE + DAY });
  expect(budget.reserve('claude', 'after')).toMatchObject({ allowed: false, reason: 'clock-rollback', retryAt: BASE + 7 * DAY });
});

test('acknowledgement is safe exactly when every deleted launch is outside the day window', () => {
  const { budget, setTime } = pruned();
  setTime(BASE + DAY - 1);
  expect(budget.acknowledgeClock('claude', { operatorConfirmed: true })).toMatchObject({ ok: false, retryAt: BASE + DAY });
  setTime(BASE + DAY);
  expect(budget.acknowledgeClock('claude', { operatorConfirmed: true })).toMatchObject({ ok: true });
  expect(budget.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastHour: 1, launchesLastDay: 1 } });
  reserve(budget); reserve(budget);
  expect(budget.reserve('claude', 'fourth')).toMatchObject({ allowed: false, reason: 'hourly-limit' });
});

test('a reopened ledger keeps the pruning boundary without adding acknowledgement audit rows on refusal', () => {
  const { databasePath, budget } = pruned(); budget.close();
  const reopened = open(databasePath);
  expect(reopened.acknowledgeClock('claude', { operatorConfirmed: true })).toMatchObject({ ok: false, retryAt: BASE + DAY });
  expect(db(databasePath).prepare('SELECT COUNT(*) AS n FROM budget_clock_acknowledgements').get()?.n).toBe(0);
});

test('a legacy ledger with unknown pruning history migrates conservatively without a schema bump', () => {
  const { databasePath, budget, setTime } = pruned(); budget.close();
  const old = db(databasePath);
  old.exec('DROP TRIGGER IF EXISTS budget_track_pruning; DROP TABLE IF EXISTS budget_pruning_state;');
  const migrated = open(databasePath);
  expect(migrated.acknowledgeClock('claude', { operatorConfirmed: true })).toMatchObject({ ok: false, retryAt: BASE + 7 * DAY });
  expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  setTime(BASE + 7 * DAY);
  expect(migrated.acknowledgeClock('claude', { operatorConfirmed: true })).toMatchObject({ ok: true });
});

test('an already-open older SQL writer cannot prune a released hold at the same observed time without tracking it', () => {
  const setTime = clock(), databasePath = path(), budget = open(databasePath), held = reserve(budget);
  budget.close();
  const old = db(databasePath);
  old.exec('DROP TRIGGER IF EXISTS budget_track_pruning; DROP TABLE IF EXISTS budget_pruning_state;');
  const release = old.prepare('UPDATE budget_reservations SET released = 1 WHERE token = ?');
  const prune = old.prepare('DELETE FROM budget_reservations WHERE provider_key = ? AND admitted_at <= ? AND released = 1');
  // These statements were prepared before the new build installs the persistent trigger.
  const modern = open(databasePath);
  setTime(BASE + 2 * DAY); reserve(modern);
  // An older build releases a previously active hold and prunes it with no change to last_observed_at.
  release.run(held.token); prune.run('claude', BASE + DAY);
  setTime(BASE + 1);
  expect(modern.acknowledgeClock('claude', { operatorConfirmed: true })).toMatchObject({ ok: false, retryAt: BASE + DAY });
  expect(old.prepare('SELECT pruned_through FROM budget_pruning_state WHERE provider_key = ?').get('claude')?.pruned_through).toBe(BASE);
});

test('pruning metadata remains one row per provider while expired released reservations are still removed', () => {
  const setTime = clock(), databasePath = path(), budget = open(databasePath);
  for (let day = 0; day < 40; day++) { setTime(BASE + day * DAY); budget.release(reserve(budget).token); }
  const connection = db(databasePath);
  expect(connection.prepare('SELECT COUNT(*) AS n FROM budget_pruning_state').get()?.n).toBe(1);
  expect(connection.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get()?.n).toBe(1);
});
