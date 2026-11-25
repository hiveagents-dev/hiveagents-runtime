import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HostLedger, type HostLaunchBudgetLimits } from '../../src/orchestration/budget/host-ledger.ts';

const roots: string[] = [], ledgers: HostLedger[] = [];
const policy: HostLaunchBudgetLimits = { concurrency: { mode: 'unlimited' },
  maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 1000 };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'oar-exact-owner-')); roots.push(directory);
  const databasePath = join(directory, 'admission.sqlite');
  const ledger = new HostLedger({ databasePath, providers: { claude: policy, codex: policy } });
  ledgers.push(ledger); return { ledger, databasePath };
}
function reserve(ledger: HostLedger, provider: string, owner: string) {
  const result = ledger.reserve(provider, owner);
  if (!result.allowed) throw Error(result.reason);
  return result.reservation;
}
afterEach(() => { vi.restoreAllMocks(); for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('finds an acknowledged or lost-ack admission by exact provider and owner without changing counters', async () => {
  const { ledger } = setup(), owner = 'oar:hosted:unique';
  expect(ledger.lookupOwner('claude', owner)).toEqual({ ok: true, reservations: [], truncated: false });
  const controller = new AbortController();
  const pending = ledger.acquire('claude', owner, { maxWaitMs: 0, signal: controller.signal });
  controller.abort(new Error('lost acknowledgement'));
  // The caller can lose the admission continuation after SQLite has committed.
  try { await pending; } catch { /* The exact-owner read works for either acknowledged outcome. */ }
  const found = ledger.lookupOwner('claude', owner);
  expect(found).toMatchObject({ ok: true, truncated: false, reservations: [{ owner, providerKey: 'claude', released: false }] });
  if (!found.ok) throw Error(found.reason);
  expect(found.reservations).toHaveLength(1);
  expect(ledger.lookupOwner('codex', owner)).toEqual({ ok: true, reservations: [], truncated: false });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('matches literal owners, never prefixes, LIKE patterns or SQL text', () => {
  const { ledger } = setup(), exact = "oar:hosted:%_' OR 1=1 --";
  const own = reserve(ledger, 'claude', exact);
  reserve(ledger, 'claude', exact + ':child'); reserve(ledger, 'claude', 'oar:hosted:other');
  reserve(ledger, 'codex', exact);
  expect(ledger.lookupOwner('claude', exact)).toEqual({ ok: true,
    reservations: [{ ...own, released: false }], truncated: false });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 3, launchesLastDay: 3 } });
});

test('bounds duplicate owner discovery and makes truncated or multiple results explicit', () => {
  const { ledger } = setup();
  for (let i = 0; i < 7; i++) reserve(ledger, 'claude', 'legacy:repeated');
  const result = ledger.lookupOwner('claude', 'legacy:repeated');
  expect(result).toMatchObject({ ok: true, truncated: true });
  if (!result.ok) throw Error(result.reason);
  expect(result.reservations).toHaveLength(2);
  expect(ledger.lookupOwner('claude', 'legacy:repeated', { limit: 7 })).toMatchObject({ ok: true, truncated: false,
    reservations: Array.from({ length: 7 }, () => expect.objectContaining({ owner: 'legacy:repeated' })) });
  expect(ledger.lookupOwner('claude', 'legacy:repeated', { limit: 1 })).toMatchObject({ ok: true, truncated: true });
});

test('exposes retained released rows and never prunes active holds or refunds launches', () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { ledger } = setup(), active = reserve(ledger, 'claude', 'old-active');
  const done = reserve(ledger, 'claude', 'old-done'); ledger.release(done.token);
  expect(ledger.lookupOwner('claude', 'old-done')).toEqual({ ok: true, reservations: [{ ...done, released: true }], truncated: false });
  now += 2 * 86_400_000;
  // Reads do not prune; a later ordinary reservation may prune completed rolling history.
  expect(ledger.lookupOwner('claude', 'old-done')).toMatchObject({ ok: true, reservations: [{ released: true }] });
  reserve(ledger, 'claude', 'new');
  expect(ledger.lookupOwner('claude', 'old-active')).toEqual({ ok: true, reservations: [{ ...active, released: false }], truncated: false });
  expect(ledger.lookupOwner('claude', 'old-done')).toEqual({ ok: true, reservations: [], truncated: false });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 2, launchesLastDay: 1 } });
});

test('rejects malformed bounds, getters and proxies without invoking their traps', () => {
  const { ledger } = setup(), trap = vi.fn(() => { throw Error('must not run'); });
  const accessor = Object.defineProperty({}, 'limit', { enumerable: true, get: trap });
  const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap });
  for (const options of [null, {}, { limit: 0 }, { limit: 101 }, { limit: Infinity }, { limit: 1.5 },
    { limit: 2, extra: true }, accessor, proxy]) {
    expect(ledger.lookupOwner('claude', 'owner', options as never)).toMatchObject({ ok: false, reason: 'invalid-input' });
  }
  for (const owner of ['', 'bad\0owner', 'x'.repeat(257), undefined])
    expect(ledger.lookupOwner('claude', owner as never)).toMatchObject({ ok: false, reason: 'invalid-input' });
  expect(trap).not.toHaveBeenCalled();
});

test('returns explicit unavailable, closed, unknown-provider and policy mismatch failures instead of absence', () => {
  const { ledger, databasePath } = setup(); reserve(ledger, 'claude', 'owner');
  expect(ledger.lookupOwner('missing', 'owner')).toMatchObject({ ok: false, reason: 'unknown-provider' });
  const other = new HostLedger({ databasePath, providers: { claude: { ...policy, maxLaunchesPerDay: 99 } } });
  ledgers.push(other);
  expect(other.lookupOwner('claude', 'owner')).toMatchObject({ ok: false, reason: 'configuration-mismatch' });
  renameSync(databasePath, databasePath + '.moved');
  expect(ledger.lookupOwner('claude', 'owner')).toMatchObject({ ok: false, reason: 'storage-unavailable' });
  ledger.close();
  expect(ledger.lookupOwner('claude', 'owner')).toMatchObject({ ok: false, reason: 'closed' });
});

test('does not advance the observed clock or hide a rollback behind an empty result', () => {
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const { ledger } = setup(); reserve(ledger, 'claude', 'owner');
  clock.mockReturnValue(now + 5000); ledger.lookupOwner('claude', 'missing');
  clock.mockReturnValue(now + 1000);
  expect(ledger.reserve('claude', 'later')).toMatchObject({ allowed: true });
  clock.mockReturnValue(now - 1);
  expect(ledger.lookupOwner('claude', 'missing')).toMatchObject({ ok: false, reason: 'clock-rollback' });
});
