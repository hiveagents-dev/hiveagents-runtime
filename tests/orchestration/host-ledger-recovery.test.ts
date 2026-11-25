import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';
const dirs: string[] = [], ledgers: HostLedger[] = [];
const acknowledgement = { workStopped: true as const, evidenceDigest: 'a'.repeat(64) };
function open(file?: string) {
  if (!file) { const dir = mkdtempSync(join(tmpdir(), 'oar-host-recovery-')); dirs.push(dir); file = join(dir, 'admission.sqlite'); }
  const ledger = new HostLedger({ databasePath: file, concurrency: { mode: 'unlimited' } }); ledgers.push(ledger); return { ledger, file };
}
function reserve(ledger: HostLedger, owner: string) { const r = ledger.reserve('claude', owner); if (!r.allowed) throw Error(r.reason); return r.reservation.token; }
afterEach(() => { ledgers.splice(0).forEach(l => l.close()); dirs.splice(0).forEach(d => rmSync(d, { force: true, recursive: true })); });

test('exact acknowledged recovery leaves post-inspection tokens active and never refunds launches', () => {
  const { ledger } = open(); const tokens = [reserve(ledger, 'app:a'), reserve(ledger, 'app:b')];
  reserve(ledger, 'app:new'); reserve(ledger, 'other:foreign');
  expect(ledger.recover({ ownerPrefix: 'app:', tokens, acknowledgement })).toEqual({ ok: true, released: 2 });
  expect(ledger.recover({ ownerPrefix: 'app:', tokens, acknowledgement })).toEqual({ ok: true, released: 0 });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 2, launchesLastDay: 4 } });
});

test('foreign or missing tokens fail atomically regardless of ordering', () => {
  const { ledger } = open(); const mine = reserve(ledger, 'app:a'), foreign = reserve(ledger, 'other:b');
  for (const tokens of [[mine, foreign], [foreign, mine], [mine, 'missing']]) {
    expect(ledger.recover({ ownerPrefix: 'app:', tokens, acknowledgement })).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 2 } });
  }
});

test('missing acknowledgement, invalid digest, duplicate and unbounded token sets fail closed', () => {
  const { ledger } = open(); const token = reserve(ledger, 'app:a');
  for (const input of [
    { ownerPrefix: 'app:', tokens: [token] },
    { ownerPrefix: '', tokens: [token], acknowledgement },
    { ownerPrefix: 'app:', tokens: [token, token], acknowledgement },
    { ownerPrefix: 'app:', tokens: Array.from({ length: 1001 }, (_, i) => `t${i}`), acknowledgement },
    { ownerPrefix: 'app:', tokens: [token], acknowledgement: { workStopped: false, evidenceDigest: 'a'.repeat(64) } },
    { ownerPrefix: 'app:', tokens: [token], acknowledgement: { workStopped: true, evidenceDigest: 'PID exited' } },
    { ownerPrefix: 'app:', tokens: [token], acknowledgement: { ...acknowledgement, pid: 12345 } },
  ]) expect(ledger.recover(input as never)).toMatchObject({ ok: false, reason: 'invalid-input' });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('reopening performs no automatic recovery based on a PID or a claimed application lock', () => {
  const { ledger, file } = open(); reserve(ledger, 'app:pid:99999999:lock-stopped'); ledger.close();
  expect(open(file).ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('a storage failure while releasing the exact set rolls back every selected release', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ledger, file } = open(); const tokens = [reserve(ledger, 'app:a'), reserve(ledger, 'app:b')];
  const db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER refuse_second BEFORE UPDATE ON budget_reservations
    WHEN OLD.owner = 'app:b' BEGIN SELECT RAISE(ABORT, 'durable release failed'); END;`);
  db.close();
  expect(ledger.recover({ ownerPrefix: 'app:', tokens, acknowledgement })).toMatchObject({ ok: false, reason: 'storage-unavailable' });
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 2, launchesLastDay: 2 } });
});
