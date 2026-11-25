import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { SharedLaunchBudget } from '../../src/orchestration/budget/index.ts';
import { HostLedger, hostLedgerPath, LaunchRefusedError, LaunchReleaseError, type HostLaunchBudgetLimits } from '../../src/orchestration/budget/host-ledger.ts';

const dirs: string[] = [], ledgers: HostLedger[] = [];
const limited = (maxConcurrent: number) => ({ mode: 'limited' as const, maxConcurrent });
function limits(overrides: Partial<HostLaunchBudgetLimits> = {}): HostLaunchBudgetLimits {
  return { concurrency: limited(1), maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 60_000, ...overrides };
}
function path() { const dir = mkdtempSync(join(tmpdir(), 'oar-host-')); dirs.push(dir); return join(dir, 'nested', 'admission.sqlite'); }
function open(databasePath = path(), policy = limits()) {
  const ledger = new HostLedger({ databasePath, providers: { claude: policy }, busyTimeoutMs: 10 });
  ledgers.push(ledger); return ledger;
}
function held(result: ReturnType<HostLedger['reserve']>) {
  expect(result.allowed).toBe(true); if (!result.allowed) throw Error(result.reason); return result.reservation;
}
afterEach(() => { ledgers.splice(0).forEach(l => l.close()); vi.restoreAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

test.each([
  ['darwin', { HOME: '/u' }, '/u/Library/Application Support/open-agent-runtime/host/admission.sqlite'],
  ['linux', { HOME: '/u' }, '/u/.local/state/open-agent-runtime/host/admission.sqlite'],
  ['linux', { HOME: '/u', XDG_STATE_HOME: '/s' }, '/s/open-agent-runtime/host/admission.sqlite'],
  ['win32', { HOME: '/u', LOCALAPPDATA: '/a' }, '/a/open-agent-runtime/host/admission.sqlite'],
] as const)('selects the local host state path for %s', (platform, env, expected) => {
  expect(hostLedgerPath(env, platform)).toBe(expected);
});

test('validates override and closed JSON options before creating any directory', () => {
  for (const p of ['relative.sqlite', '/tmp/../bad.sqlite', '/tmp/bad\0.sqlite']) {
    expect(() => hostLedgerPath({ OAR_HOST_LEDGER: p })).toThrow(TypeError);
  }
  const file = path();
  for (const bad of [
    { concurrency: { mode: 'unlimited', maxConcurrent: 0 } },
    { providers: { claude: { ...limits(), concurrency: Object.defineProperty({}, 'mode', { value: 'unlimited' }) } } },
    { concurrency: limited(-1) }, { concurrency: limited(Infinity) },
    { concurrency: limited(1), providers: { claude: limits() } }, { mystery: true },
    { providers: { claude: { ...limits(), extra: 1 } } },
    { providers: { claude: { ...limits(), quotaCooldownMs: 0 } } },
    { providers: new Map() }, { providers: null }, { concurrency: null }, { providers: undefined },
  ]) expect(() => new HostLedger({ databasePath: file, ...bad } as never)).toThrow(TypeError);
  expect(() => new HostLedger(Object.assign(Object.create({ concurrency: limited(1) }), { databasePath: file }))).toThrow(TypeError);
  expect(existsSync(join(file, '..'))).toBe(false);
});

test('default and shorthand policies cap cooperating claude and codex keys', () => {
  const ledger = new HostLedger({ databasePath: path(), concurrency: limited(2) }); ledgers.push(ledger);
  held(ledger.reserve('claude', 'a')); held(ledger.reserve('claude', 'b'));
  expect(ledger.reserve('claude', 'c')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  held(ledger.reserve('codex', 'a'));
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { limits: { concurrency: limited(2), maxLaunchesPerHour: 400, maxLaunchesPerDay: 800 } } });
  const defaults = new HostLedger({ databasePath: path() }); ledgers.push(defaults);
  for (let i = 0; i < 3; i++) held(defaults.reserve('claude', String(i)));
  expect(defaults.reserve('claude', 'fourth')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
});

test('limited zero disables admission and does not wait', async () => {
  const ledger = open(path(), limits({ concurrency: limited(0) }));
  await expect(ledger.acquire('claude', 'a', { maxWaitMs: 20_000 })).resolves.toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 0 } });
});

test('explicit unlimited admits more than three without removing hourly daily or cooldown fuses', () => {
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const ledger = open(path(), limits({ concurrency: { mode: 'unlimited' }, maxLaunchesPerHour: 4, maxLaunchesPerDay: 5, quotaCooldownMs: 50 }));
  for (let i = 0; i < 4; i++) held(ledger.reserve('claude', String(i)));
  expect(ledger.reserve('claude', 'hour')).toMatchObject({ allowed: false, reason: 'hourly-limit' });
  now += 3_600_000; held(ledger.reserve('claude', 'fifth'));
  expect(ledger.reserve('claude', 'day')).toMatchObject({ allowed: false, reason: 'daily-limit' });
  ledger.recordQuotaError('claude');
  expect(ledger.reserve('claude', 'quota')).toMatchObject({ allowed: false, reason: 'quota-cooldown' });
});

test('host clients adopt the persisted mode; a legacy finite-only client cannot override unlimited', () => {
  const file = path(), unlimited = limits({ concurrency: { mode: 'unlimited' } });
  held(open(file, unlimited).reserve('claude', 'a'));
  expect(open(file, unlimited).status('claude')).toMatchObject({ ok: true, status: { active: 1, limits: { concurrency: { mode: 'unlimited' } } } });
  for (const concurrency of [limited(0), limited(3)]) {
    expect(open(file, limits({ concurrency })).reserve('claude', 'b').allowed).toBe(true);
  }
  const finite = new SharedLaunchBudget({ databasePath: file, providers: { claude: { maxConcurrent: 0, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 60_000 } } });
  try { expect(finite.reserve('claude', 'old')).toMatchObject({ allowed: false, reason: 'configuration-mismatch' }); } finally { finite.close(); }
  const other = path(); open(other).reserve('claude', 'a');
  expect(open(other, unlimited).reserve('claude', 'b')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
});

test('legacy rows without concurrency mode remain limited and retain active debits', () => {
  const file = path(), ledger = open(file); held(ledger.reserve('claude', 'a')); ledger.close();
  const db = new DatabaseSync(file); db.exec('DROP TABLE budget_concurrency_modes'); db.close();
  expect(open(file).reserve('claude', 'b')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  expect(open(file, limits({ concurrency: { mode: 'unlimited' } })).reserve('claude', 'c')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
});

test('withSlot holds pending work despite cancellation and releases only after actual settlement', async () => {
  const ledger = open(); const controller = new AbortController(); let finish!: (value: string) => void;
  const work = ledger.withSlot('claude', 'a', { maxWaitMs: 0, signal: controller.signal }, () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve(); controller.abort('stop');
  expect(ledger.reserve('claude', 'b')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
  finish('done'); await expect(work).resolves.toBe('done');
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
});

test('release failure overrides success and preserves original operation error as cause', async () => {
  const file = path(), ledger = open(file); const failure = new Error('operation failed');
  const result = ledger.withSlot('claude', 'a', { maxWaitMs: 0 }, async () => { renameSync(file, `${file}.moved`); throw failure; });
  await expect(result).rejects.toMatchObject({ name: 'LaunchReleaseError', cause: failure, failure: { reason: 'storage-unavailable' } });
  await expect(result).rejects.toBeInstanceOf(LaunchReleaseError);
  const second = open();
  await expect(second.withSlot('claude', 'a', { maxWaitMs: 0 }, async () => { second.close(); return 1; })).rejects.toMatchObject({ name: 'LaunchReleaseError', failure: { reason: 'closed' } });
});

test('quota classification persists cooldown before releasing and admission failure throws typed refusal', async () => {
  const ledger = open(), quota = new Error('quota');
  await expect(ledger.withSlot('claude', 'a', { maxWaitMs: 0, isQuotaError: e => e === quota }, async () => { throw quota; })).rejects.toBe(quota);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, pausedUntil: expect.any(Number) } });
  await expect(ledger.withSlot('claude', 'b', { maxWaitMs: 0 }, async () => 'ran')).rejects.toBeInstanceOf(LaunchRefusedError);
});

test('shared finite API rejects unknown JSON fields and limited zero stays disabled', () => {
  const file = path(), policy = { maxConcurrent: 0, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 60_000 };
  for (const options of [
    { databasePath: file, providers: { claude: policy }, extra: true },
    { databasePath: file, providers: { claude: { ...policy, concurrency: { mode: 'unlimited' } } } },
    { databasePath: file, providers: new Map() },
  ]) expect(() => new SharedLaunchBudget(options as never)).toThrow(TypeError);
  // Host constructor supplies the existing parent; finite API deliberately does not mkdir.
  open(file).close();
  const finite = new SharedLaunchBudget({ databasePath: path().replace('/nested/', '/'), providers: { claude: policy } });
  try {
    expect(finite.reserve('claude', 'disabled')).toMatchObject({ allowed: false, reason: 'concurrency-limit' });
    expect(finite.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 0, limits: policy } });
  } finally { finite.close(); }
});

test('unlimited retains rollback protection and never prunes an active reservation', () => {
  let now = 10 * 86_400_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const ledger = open(path(), limits({ concurrency: { mode: 'unlimited' } }));
  const active = held(ledger.reserve('claude', 'active'));
  ledger.release(held(ledger.reserve('claude', 'completed')).token);
  now += 7 * 86_400_000; held(ledger.reserve('claude', 'future'));
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 2, launchesLastDay: 1 } });
  now -= 7 * 86_400_000;
  expect(ledger.reserve('claude', 'rollback')).toMatchObject({ allowed: false, reason: 'clock-rollback' });
  now += 7 * 86_400_000;
  const state = ledger.status('claude');
  expect(state.ok && state.status.reservations.some(r => r.token === active.token)).toBe(true);
});

test('withSlot skips the operation when aborted after admission before its continuation', async () => {
  const ledger = open(), controller = new AbortController(), reason = { stopped: 'before-operation' };
  let started = false;
  const work = ledger.withSlot('claude', 'aborted-before-start', { maxWaitMs: 0, signal: controller.signal }, async () => { started = true; return 'unexpected'; });
  controller.abort(reason);
  await expect(work).rejects.toBe(reason);
  expect(started).toBe(false);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
});

test('withSlot skips the operation after close and exposes the failed durable release', async () => {
  const file = path(), ledger = open(file);
  let started = false;
  const work = ledger.withSlot('claude', 'closed-before-start', { maxWaitMs: 0 }, async () => { started = true; return 'unexpected'; });
  ledger.close();
  await expect(work).rejects.toMatchObject({ name: 'LaunchReleaseError', failure: { reason: 'closed' }, cause: { name: 'LaunchRefusedError', admission: { allowed: false, reason: 'closed' } } });
  expect(started).toBe(false);
  expect(open(file).status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('withSlot preserves pre-start abort reason as cause when close also prevents release', async () => {
  const file = path(), ledger = open(file), controller = new AbortController(), reason = { stopped: 'then-closed' };
  let started = false;
  const work = ledger.withSlot('claude', 'abort-close-before-start', { maxWaitMs: 0, signal: controller.signal }, async () => { started = true; return 'unexpected'; });
  controller.abort(reason); ledger.close();
  await expect(work).rejects.toMatchObject({ name: 'LaunchReleaseError', failure: { reason: 'closed' } });
  await expect(work).rejects.toHaveProperty('cause', reason);
  expect(started).toBe(false);
  expect(open(file).status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('withSlot snapshots the quota classifier before its admission continuation', async () => {
  const ledger = open(), quota = new Error('quota before classifier mutation');
  const options = { maxWaitMs: 0, isQuotaError: (error: unknown) => error === quota };
  const work = ledger.withSlot('claude', 'quota-snapshot', options, async () => { throw quota; });
  options.isQuotaError = () => false;
  await expect(work).rejects.toBe(quota);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1, pausedUntil: expect.any(Number) } });
});

test('a failed quota cooldown write is nominally visible and still attempts durable release', async () => {
  const file = path(), ledger = open(file), quota = new Error('provider quota');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER reject_cooldown BEFORE UPDATE OF paused_until ON budget_providers BEGIN SELECT RAISE(ABORT, 'cannot persist cooldown'); END;`); db.close();
  const work = ledger.withSlot('claude', 'quota-write-failure', { maxWaitMs: 0, isQuotaError: error => error === quota }, async () => { throw quota; });
  await expect(work).rejects.toMatchObject({ name: 'LaunchQuotaRecordError', failure: { reason: 'storage-unavailable' }, cause: quota });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
});

test('release failure wins over failed cooldown persistence while retaining the original error chain', async () => {
  const file = path(), ledger = open(file), quota = new Error('provider quota and durable release');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER reject_cooldown BEFORE UPDATE OF paused_until ON budget_providers BEGIN SELECT RAISE(ABORT, 'cannot persist cooldown'); END;
    CREATE TRIGGER reject_release BEFORE UPDATE OF released ON budget_reservations BEGIN SELECT RAISE(ABORT, 'cannot persist release'); END;`); db.close();
  const work = ledger.withSlot('claude', 'quota-and-release-failure', { maxWaitMs: 0, isQuotaError: error => error === quota }, async () => { throw quota; });
  await expect(work).rejects.toMatchObject({ name: 'LaunchReleaseError', failure: { reason: 'storage-unavailable' }, cause: { name: 'LaunchQuotaRecordError', failure: { reason: 'storage-unavailable' }, cause: quota } });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('pre-start cancellation is never classified as an observed provider quota error', async () => {
  const ledger = open(), controller = new AbortController(), reason = new Error('stopped before provider work');
  const work = ledger.withSlot('claude', 'aborted-not-provider-quota', { maxWaitMs: 0, signal: controller.signal, isQuotaError: () => true }, async () => 'unexpected');
  controller.abort(reason);
  await expect(work).rejects.toBe(reason);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1, pausedUntil: null } });
});
