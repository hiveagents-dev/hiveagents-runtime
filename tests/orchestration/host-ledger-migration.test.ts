import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedLaunchBudget } from '../../src/orchestration/budget/index.ts';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';
import { inspectLegacyLaunchBudget } from '../../src/orchestration/budget/legacy-migration.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'oar-budget-migration-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'old.sqlite'), target = join(directory, 'host.sqlite');
  const finite = { maxConcurrent: 3, maxLaunchesPerHour: 400, maxLaunchesPerDay: 800, quotaCooldownMs: 60_000 };
  const old = new SharedLaunchBudget({ databasePath: source, providers: { claude: finite, codex: finite } });
  const host = new HostLedger({ databasePath: target, concurrency: { mode: 'unlimited' } });
  cleanup.push(() => old.close(), () => host.close());
  const reserve = (provider = 'claude', owner = 'old-run') => {
    const admission = old.reserve(provider, owner);
    if (!admission.allowed) throw new Error(admission.reason);
    return admission.reservation.token;
  };
  const migrate = () => host.importLegacy({ databasePath: source, ownerPrefix: 'grow:', sourceStoppedConfirmed: true,
    expectedDigest: inspectLegacyLaunchBudget(source).sourceDigest });
  return { source, target, old, host, reserve, migrate };
}

describe('explicit legacy launch history migration', () => {
  it('keeps debits and active holds, preserves unlimited and never touches the source', () => {
    const f = fixture(); const token = f.reserve(); f.old.release(f.reserve()); f.old.release(f.reserve('codex'));
    const inspection = inspectLegacyLaunchBudget(f.source);
    expect(JSON.stringify(inspection)).not.toContain(token);
    expect(f.host.verifyLegacyMigration({ databasePath: f.source, ownerPrefix: 'grow:' })).toMatchObject({ ok: true, matched: false });
    expect(f.migrate()).toMatchObject({ ok: true, imported: 3 });
    expect(f.migrate()).toMatchObject({ ok: true, imported: 0 });
    expect(f.host.verifyLegacyMigration({ databasePath: f.source, ownerPrefix: 'grow:' })).toMatchObject({ ok: true, matched: true });
    expect(f.host.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastHour: 2,
      limits: { concurrency: { mode: 'unlimited' } }, reservations: [{ owner: 'grow:old-run' }] } });
    for (let n = 0; n < 4; n++) expect(f.host.reserve('claude', `marketing:${n}`).allowed).toBe(true);
    expect(inspectLegacyLaunchBudget(f.source)).toEqual(inspection);
    expect(f.old.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastHour: 2 } });
  });

  it('requires stopped-source acknowledgement and the exact inspected digest', () => {
    const f = fixture(); f.reserve(); const sourceDigest = inspectLegacyLaunchBudget(f.source).sourceDigest;
    expect(f.host.importLegacy({ databasePath: f.source, ownerPrefix: 'grow:', expectedDigest: sourceDigest, sourceStoppedConfirmed: false } as never)).toMatchObject({ ok: false, reason: 'invalid-input' });
    f.reserve();
    expect(f.host.importLegacy({ databasePath: f.source, ownerPrefix: 'grow:', expectedDigest: sourceDigest, sourceStoppedConfirmed: true })).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(f.host.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastHour: 0 } });
  });

  it('detects changed old history, imports new debits once and never reholds recovered tokens', () => {
    const f = fixture(); f.reserve(); expect(f.migrate().ok).toBe(true);
    const status = f.host.status('claude'); if (!status.ok) throw new Error(status.reason);
    f.host.release(status.status.reservations[0]!.token);
    f.reserve();
    expect(f.host.verifyLegacyMigration({ databasePath: f.source, ownerPrefix: 'grow:' })).toMatchObject({ ok: true, matched: false });
    expect(f.migrate()).toMatchObject({ ok: true, imported: 1 });
    expect(f.host.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastHour: 2 } });
  });

  it('keeps quota cooldowns shared and unrefunded', () => {
    const f = fixture(); f.old.release(f.reserve()); f.old.recordQuotaError('claude');
    expect(f.migrate().ok).toBe(true);
    expect(f.host.reserve('claude', 'marketing:waiting')).toMatchObject({ allowed: false, reason: 'quota-cooldown' });
    expect(f.host.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
  });

  it('never resurrects a recovered hold after normal pruning and a later source revision', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); f.reserve(); expect(f.migrate().ok).toBe(true);
    const first = f.host.status('claude'); if (!first.ok) throw new Error(first.reason);
    f.host.release(first.status.reservations[0]!.token);
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    const pruning = f.host.reserve('claude', 'marketing:prune'); if (!pruning.allowed) throw new Error(pruning.reason);
    f.host.release(pruning.reservation.token);
    f.reserve('claude', 'new-run');
    expect(f.migrate()).toMatchObject({ ok: true, imported: 1 });
    expect(f.host.status('claude')).toMatchObject({ ok: true, status: { active: 1, reservations: [{ owner: 'grow:new-run' }] } });
  });

  it('rolls back every copied row and the migration marker on a persistence failure', () => {
    const f = fixture(); f.reserve(); f.reserve('codex'); f.host.reserve('claude', 'marketing:foreign');
    const source = new DatabaseSync(f.source); cleanup.push(() => source.close());
    source.exec("UPDATE budget_reservations SET token=CASE provider_key WHEN 'claude' THEN 'a' ELSE 'b' END;");
    const db = new DatabaseSync(f.target); cleanup.push(() => db.close());
    db.exec("CREATE TRIGGER reject_migration BEFORE INSERT ON budget_reservations WHEN NEW.provider_key='codex' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    expect(f.migrate()).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    expect(f.host.verifyLegacyMigration({ databasePath: f.source, ownerPrefix: 'grow:' })).toMatchObject({ ok: true, matched: false });
    expect(f.host.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastHour: 1, reservations: [{ owner: 'marketing:foreign' }] } });
    expect(f.host.status('codex')).toMatchObject({ ok: true, status: { active: 0, launchesLastHour: 0 } });
    db.exec('DROP TRIGGER reject_migration');
    expect(f.migrate()).toMatchObject({ ok: true, imported: 2 });
  });

  it('preserves the maximum observed clock, cooldown and pruning watermark', () => {
    const f = fixture(); f.reserve(); f.host.status('claude');
    const source = new DatabaseSync(f.source), target = new DatabaseSync(f.target);
    cleanup.push(() => source.close(), () => target.close());
    const now = Date.now();
    source.prepare("UPDATE budget_providers SET paused_until=?,last_observed_at=? WHERE provider_key='claude'").run(now + 30000, now + 10000);
    source.prepare("UPDATE budget_pruning_state SET pruned_through=? WHERE provider_key='claude'").run(now + 3000);
    target.prepare("UPDATE budget_providers SET paused_until=?,last_observed_at=? WHERE provider_key='claude'").run(now + 40000, now + 20000);
    target.prepare('INSERT INTO budget_pruning_state VALUES (?,?) ON CONFLICT(provider_key) DO UPDATE SET pruned_through=excluded.pruned_through').run('claude', now + 5000);
    expect(f.migrate().ok).toBe(true);
    expect(target.prepare("SELECT paused_until,last_observed_at FROM budget_providers WHERE provider_key='claude'").get()).toMatchObject({ paused_until: now + 40000, last_observed_at: now + 20000 });
    expect(target.prepare("SELECT pruned_through FROM budget_pruning_state WHERE provider_key='claude'").get()).toMatchObject({ pruned_through: now + 5000 });
    expect(f.host.reserve('claude', 'marketing:clock')).toMatchObject({ allowed: false, reason: 'clock-rollback' });
  });

  it('rejects source equals destination and invalid paths without destructive rewrites', () => {
    const f = fixture(); f.reserve(); const digest = inspectLegacyLaunchBudget(f.source).sourceDigest;
    expect(f.host.importLegacy({ databasePath: f.target, ownerPrefix: 'grow:', expectedDigest: digest, sourceStoppedConfirmed: true })).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(() => inspectLegacyLaunchBudget('../invalid')).toThrow();
    expect(f.old.status('claude')).toMatchObject({ ok: true, status: { active: 1 } });
  });
});
