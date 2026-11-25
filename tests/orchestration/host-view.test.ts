import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';
import { readHostLedgerView } from '../../src/orchestration/budget/host-view.ts';

const dirs: string[] = [], ledgers: HostLedger[] = [];
function dir() { const d = mkdtempSync(join(tmpdir(), 'oar-host-view-')); dirs.push(d); return d; }
function open(databasePath: string, concurrency: { mode: 'limited'; maxConcurrent: number } | { mode: 'unlimited' }) {
  const l = new HostLedger({ databasePath, concurrency }); ledgers.push(l); return l;
}
function hold(l: HostLedger, provider: string, owner: string) { const r = l.reserve(provider, owner); if (!r.allowed) throw Error(r.reason); return r.reservation.token; }
afterEach(() => { ledgers.splice(0).forEach(l => l.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

test('a ledger that was never created reads as absent and is not created', () => {
  const file = join(dir(), 'admission.sqlite');
  expect(readHostLedgerView(file)).toEqual({ ok: false, reason: 'absent' });
  expect(() => statSync(file)).toThrow();
});

test('a file that is not this ledger reads as unrecognized', () => {
  const d = dir(), empty = join(d, 'empty.sqlite'), foreign = join(d, 'foreign.sqlite');
  writeFileSync(empty, '');
  const db = new DatabaseSync(foreign); db.exec('CREATE TABLE t(a)'); db.close();
  expect(readHostLedgerView(empty)).toEqual({ ok: false, reason: 'unrecognized' });
  expect(readHostLedgerView(foreign)).toEqual({ ok: false, reason: 'unrecognized' });
});

test('shows holds by owner, launch counts and limits, and never a token', () => {
  const file = join(dir(), 'admission.sqlite'), ledger = open(file, { mode: 'limited', maxConcurrent: 3 });
  const kept = hold(ledger, 'claude', 'grow:run-1'), released = hold(ledger, 'claude', 'marketing:abc');
  hold(ledger, 'codex', 'grow:run-2');
  ledger.release(released);
  const view = readHostLedgerView(file);
  if (!view.ok) throw Error(view.reason);
  expect(view.providers.map(p => p.providerKey)).toEqual(['claude', 'codex']);
  const claude = view.providers[0]!;
  expect(claude.concurrency).toEqual({ mode: 'limited', maxConcurrent: 3 });
  expect(claude.active.map(h => h.owner)).toEqual(['grow:run-1']);
  expect(claude).toMatchObject({ launchesLastHour: 2, launchesLastDay: 2, maxLaunchesPerHour: 400, maxLaunchesPerDay: 800, pausedUntil: null });
  expect(JSON.stringify(view)).not.toContain(kept);
});

test('a quota pause shows until it ends', () => {
  const file = join(dir(), 'admission.sqlite'), ledger = open(file, { mode: 'limited', maxConcurrent: 3 });
  hold(ledger, 'codex', 'grow:run-1');
  expect(ledger.recordQuotaError('codex')).toMatchObject({ ok: true });
  const now = Date.now(), during = readHostLedgerView(file, now);
  if (!during.ok) throw Error(during.reason);
  expect(during.providers[0]!.pausedUntil).toBeGreaterThan(now);
  const after = readHostLedgerView(file, now + 3_600_000);
  if (!after.ok) throw Error(after.reason);
  expect(after.providers[0]!.pausedUntil).toBeNull();
});

test('an unlimited ledger says so', () => {
  const file = join(dir(), 'admission.sqlite'), ledger = open(file, { mode: 'unlimited' });
  hold(ledger, 'claude', 'grow:run-1');
  const view = readHostLedgerView(file);
  if (!view.ok) throw Error(view.reason);
  expect(view.providers[0]!.concurrency).toEqual({ mode: 'unlimited' });
});

test('reading changes nothing and needs no matching policy', () => {
  const file = join(dir(), 'admission.sqlite'), ledger = open(file, { mode: 'limited', maxConcurrent: 5 });
  hold(ledger, 'claude', 'grow:run-1');
  const before = statSync(file, { bigint: true }).mtimeNs;
  for (let i = 0; i < 3; i += 1) expect(readHostLedgerView(file).ok).toBe(true);
  expect(statSync(file, { bigint: true }).mtimeNs).toBe(before);
  // The writer is unaffected: it still admits and reports with its own policy.
  expect(ledger.reserve('claude', 'grow:run-2')).toMatchObject({ allowed: true });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 2 } });
});

test('a relative path is a programming error', () => {
  expect(() => readHostLedgerView('admission.sqlite')).toThrow(TypeError);
});

test('launches waiting for a slot show by priority, and lapsed declarations do not count', () => {
  const file = join(dir(), 'admission.sqlite'), ledger = open(file, { mode: 'limited', maxConcurrent: 1 });
  hold(ledger, 'claude', 'grow:run-1');
  const none = readHostLedgerView(file);
  if (!none.ok) throw Error(none.reason);
  expect(none.providers[0]!.waiting).toEqual({ normal: 0, low: 0 });
  const now = Date.now(), db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS budget_waiters (waiter TEXT PRIMARY KEY NOT NULL, provider_key TEXT NOT NULL, priority INTEGER NOT NULL, seen_at INTEGER NOT NULL) STRICT`);
  const add = db.prepare('INSERT INTO budget_waiters(waiter, provider_key, priority, seen_at) VALUES (?, ?, ?, ?)');
  add.run('a', 'claude', 1, now); add.run('b', 'claude', 1, now); add.run('c', 'claude', 0, now);
  add.run('old', 'claude', 1, now - 10 * 60_000);
  db.close();
  const view = readHostLedgerView(file, now);
  if (!view.ok) throw Error(view.reason);
  expect(view.providers[0]!.waiting).toEqual({ normal: 2, low: 1 });
});
