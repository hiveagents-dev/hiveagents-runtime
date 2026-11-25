import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';

const roots: string[] = [], ledgers: HostLedger[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oar-ledger-identity-')); roots.push(root);
  const path = join(root, 'actual', 'admission.sqlite'); mkdirSync(join(root, 'actual'));
  return { root, path };
}
function open(databasePath: string) { const ledger = new HostLedger({ databasePath }); ledgers.push(ledger); return ledger; }
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('measures one stable physical ledger identity across connections and budget mutations', () => {
  const { path } = fixture(), first = open(path), second = open(path), binding = first.storageIdentity();
  expect(binding).toMatchObject({ ok: true, identity: { format: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(second.storageIdentity()).toEqual(binding);
  const held = first.reserve('claude', 'owner'); if (!held.allowed) throw Error(held.reason);
  expect(first.storageIdentity()).toEqual(binding); second.release(held.reservation.token);
  expect(first.storageIdentity()).toEqual(binding);
  expect(first.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
});

test('does not change ledger bytes, advance counters or disclose paths and private tokens', () => {
  const { path } = fixture(), ledger = open(path), held = ledger.reserve('claude', 'private-owner');
  if (!held.allowed) throw Error(held.reason);
  const bytes = readFileSync(path), binding = ledger.storageIdentity();
  expect(readFileSync(path)).toEqual(bytes);
  expect(JSON.stringify(binding)).not.toContain(path); expect(JSON.stringify(binding)).not.toContain(held.reservation.token);
  expect(ledger.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

test('does not identify a byte-for-byte copied database as the original ledger', () => {
  const { root, path } = fixture(), first = open(path), binding = first.storageIdentity();
  const copy = join(root, 'copy.sqlite'); copyFileSync(path, copy);
  expect(open(copy).storageIdentity()).not.toEqual(binding);
});

test.skipIf(process.platform === 'win32')('canonicalizes an ancestor alias to the same pinned file identity', () => {
  const { root, path } = fixture(), first = open(path);
  symlinkSync(join(root, 'actual'), join(root, 'alias'));
  expect(open(join(root, 'alias/admission.sqlite')).storageIdentity()).toEqual(first.storageIdentity());
});

test('replacement, corrupt storage and closed handles return failure rather than a claimed identity', () => {
  const { root, path } = fixture(), ledger = open(path);
  renameSync(path, path + '.old'); copyFileSync(path + '.old', path);
  expect(ledger.storageIdentity()).toMatchObject({ ok: false, reason: 'storage-unavailable' });
  ledger.close(); expect(ledger.storageIdentity()).toMatchObject({ ok: false, reason: 'closed' });
  const corrupt = resolve(root, 'corrupt.sqlite'); writeFileSync(corrupt, 'invalid database');
  expect(open(corrupt).storageIdentity()).toMatchObject({ ok: false, reason: 'storage-unavailable' });
});

test('identity failures do not disclose the private database path', () => {
  const { path } = fixture(), ledger = open(path); renameSync(path, path + '.removed');
  const failure = ledger.storageIdentity();
  expect(failure).toEqual({ ok: false, reason: 'storage-unavailable' });
  expect(JSON.stringify(failure)).not.toContain(path);
});
