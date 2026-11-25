import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';
import { readHostLedgerView } from '../../src/orchestration/budget/host-view.ts';
import { inspectLegacyLaunchBudget } from '../../src/orchestration/budget/legacy-migration.ts';
import { freeSilently, ring, stillPending, until, waiting } from './budget-fixtures/priority-probe.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** The first published version-1 layout: two tables and nothing that later builds added. */
const FIRST_PUBLISHED_SCHEMA = `
CREATE TABLE budget_providers (
  provider_key TEXT PRIMARY KEY NOT NULL CHECK(length(provider_key) BETWEEN 1 AND 256),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent BETWEEN 0 AND 9007199254740991),
  max_hour INTEGER NOT NULL CHECK(max_hour BETWEEN 0 AND 9007199254740991),
  max_day INTEGER NOT NULL CHECK(max_day BETWEEN 0 AND 9007199254740991),
  cooldown_ms INTEGER NOT NULL CHECK(cooldown_ms BETWEEN 1 AND 9007199254740991),
  paused_until INTEGER NOT NULL CHECK(paused_until BETWEEN 0 AND 9007199254740991),
  last_observed_at INTEGER NOT NULL CHECK(last_observed_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE budget_reservations (
  token TEXT PRIMARY KEY NOT NULL,
  provider_key TEXT NOT NULL REFERENCES budget_providers(provider_key),
  owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 256),
  admitted_at INTEGER NOT NULL CHECK(admitted_at BETWEEN 0 AND 9007199254740991),
  released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0, 1))
) STRICT;
CREATE INDEX budget_reservations_provider_time ON budget_reservations(provider_key, admitted_at);
PRAGMA application_id = ${0x4f415242};
PRAGMA user_version = 1;`;

function olderLedger(): { file: string; admittedAt: number } {
  const directory = mkdtempSync(join(tmpdir(), 'oar-host-priority-migration-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'ledger.sqlite');
  const admittedAt = Date.now() - 60_000;
  const db = new DatabaseSync(file);
  db.exec(FIRST_PUBLISHED_SCHEMA);
  db.prepare('INSERT INTO budget_providers VALUES (?, 1, 100, 100, 80, 0, ?)').run('claude', admittedAt);
  const insert = db.prepare('INSERT INTO budget_reservations(token, provider_key, owner, admitted_at, released) VALUES (?, ?, ?, ?, ?)');
  insert.run('old-active-token', 'claude', 'old-app:running', admittedAt, 0);
  insert.run('old-finished-token', 'claude', 'old-app:finished', admittedAt, 1);
  db.close();
  return { file, admittedAt };
}

function open(file: string): HostLedger {
  const ledger = new HostLedger({
    databasePath: file,
    providers: { claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 80 } },
  });
  cleanup.push(() => ledger.close());
  return ledger;
}

function tables(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => String(row.name));
  } finally {
    db.close();
  }
}

test('an older ledger file gains the waiting queue in place and keeps everything it held', async () => {
  const { file, admittedAt } = olderLedger();
  const canary = open(file), production = open(file);
  expect(tables(file)).not.toContain('budget_waiters');

  // The hold recorded by the older build still counts, so a production run waits behind it.
  const productionRun = production.acquire('claude', 'production', { maxWaitMs: 8000 });
  await until(() => waiting(file).length === 1, 'the production run to be waiting');
  expect(tables(file)).toContain('budget_waiters');

  // The hold is freed with a plain statement and no bell, so the production run is still asleep
  // when the canary looks: the canary's answer depends on the queue alone, not on who wakes first.
  freeSilently(file, 'old-active-token');
  expect(canary.reserve('claude', 'canary', 'low')).toMatchObject({ allowed: false, reason: 'concurrency-limit', outranked: true });
  const canaryRun = canary.acquire('claude', 'canary', { maxWaitMs: 8000, priority: 'low' });
  expect(await stillPending(canaryRun)).toBe(true);
  expect(production.status('claude')).toMatchObject({ ok: true, status: { active: 0 } });

  ring(file);
  const admitted = await productionRun;
  if (!admitted.allowed) throw new Error(admitted.reason);
  expect(await stillPending(canaryRun)).toBe(true);
  production.release(admitted.reservation.token);
  await expect(canaryRun).resolves.toMatchObject({ allowed: true });

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(db.prepare('PRAGMA application_id').get()?.application_id).toBe(0x4f415242);
    expect(db.prepare('SELECT owner, admitted_at AS admittedAt, released FROM budget_reservations WHERE token LIKE ? ORDER BY token').all('old-%'))
      .toEqual([
        { owner: 'old-app:running', admittedAt, released: 1 },
        { owner: 'old-app:finished', admittedAt, released: 1 },
      ]);
    expect(db.prepare('SELECT COUNT(*) AS waiting FROM budget_waiters').get()?.waiting).toBe(0);
  } finally {
    db.close();
  }
});

test('every existing reader and an older writer keep working on the migrated file', async () => {
  const { file } = olderLedger();
  const ledger = open(file);
  expect(ledger.release('old-active-token')).toEqual({ ok: true, released: true });
  await expect(ledger.acquire('claude', 'new-build', { maxWaitMs: 1000, priority: 'low' })).resolves.toMatchObject({ allowed: true });
  expect(tables(file)).toContain('budget_waiters');

  // The read-only screen view and the legacy inspection both pin user_version 1.
  const view = readHostLedgerView(file);
  expect(view).toMatchObject({ ok: true, providers: [{ providerKey: 'claude', launchesLastDay: 3, active: [{ owner: 'new-build' }] }] });
  expect(inspectLegacyLaunchBudget(file).providers).toEqual([{ providerKey: 'claude', reservations: 3, active: 1 }]);

  // What a process on an older build does: the same checks, then its own plain statements.
  const older = new DatabaseSync(file);
  try {
    older.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    expect(older.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(older.prepare('PRAGMA quick_check(1)').get()?.quick_check).toBe('ok');
    expect(older.prepare('PRAGMA foreign_key_check').get()).toBeUndefined();
    const active = older.prepare('SELECT COUNT(*) AS active FROM budget_reservations WHERE provider_key = ? AND released = 0').get('claude');
    expect(active?.active).toBe(1);
    older.prepare('UPDATE budget_reservations SET released = 1 WHERE owner = ?').run('new-build');
    older.prepare('INSERT INTO budget_reservations(token, provider_key, owner, admitted_at) VALUES (?, ?, ?, ?)').run('older-build-token', 'claude', 'old-app:again', Date.now());
    older.exec('COMMIT');
  } finally {
    older.close();
  }
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, reservations: [{ owner: 'old-app:again' }] } });
  expect(ledger.reserve('claude', 'canary', 'low')).toEqual({ allowed: false, reason: 'concurrency-limit' });
});

test('callers that never wait and pass no priority leave an older file without the new table', () => {
  const { file } = olderLedger();
  const ledger = open(file);
  expect(ledger.reserve('claude', 'default')).toEqual({ allowed: false, reason: 'concurrency-limit' });
  expect(ledger.release('old-active-token')).toEqual({ ok: true, released: true });
  expect(ledger.reserve('claude', 'default')).toMatchObject({ allowed: true });
  expect(tables(file)).not.toContain('budget_waiters');
});
