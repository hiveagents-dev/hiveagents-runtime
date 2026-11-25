import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const APPLICATION_ID = 0x4f415242;
const HOUR = 3_600_000, DAY = 86_400_000, WAITER_LEASE_MS = 90_000;

/** One active hold, without its bearer token. */
export interface HostHoldView { owner: string; admittedAt: number }
export interface HostProviderView {
  providerKey: string;
  concurrency: { mode: 'limited'; maxConcurrent: number } | { mode: 'unlimited' };
  maxLaunchesPerHour: number;
  maxLaunchesPerDay: number;
  launchesLastHour: number;
  launchesLastDay: number;
  /** Epoch ms while a quota pause is running; null otherwise. */
  pausedUntil: number | null;
  active: HostHoldView[];
  /** Launches declared as waiting for a slot of this provider: `normal` is production, `low` is a canary or trial. */
  waiting: { normal: number; low: number };
}
export type HostLedgerView =
  | { ok: true; readAt: number; providers: HostProviderView[] }
  | { ok: false; reason: 'absent' | 'unrecognized' | 'unavailable' };

/**
 * What the shared admission ledger holds right now, for a screen. Opens the file read-only, so it
 * needs no concurrency policy, never creates or migrates the file, never touches the clock mark and
 * can never refuse a launch. Tokens stay inside the ledger.
 */
export function readHostLedgerView(databasePath: string, now: number = Date.now()): HostLedgerView {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)) throw new TypeError('databasePath must be an absolute path');
  if (!existsSync(databasePath)) return { ok: false, reason: 'absent' };
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath, { readOnly: true }); }
  catch { return { ok: false, reason: 'unavailable' }; }
  try {
    db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON;');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
      || db.prepare('PRAGMA user_version').get()?.user_version !== 1) return { ok: false, reason: 'unrecognized' };
    const hasModes = db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'budget_concurrency_modes'`).get() !== undefined;
    db.exec('BEGIN');
    try {
      const hasWaiters = db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'budget_waiters'`).get() !== undefined;
      const rows = db.prepare(`SELECT provider_key, max_concurrent, max_hour, max_day, paused_until FROM budget_providers ORDER BY provider_key`).all();
      const providers = rows.map((row): HostProviderView => {
        const key = String(row.provider_key);
        const mode = hasModes ? db.prepare('SELECT mode FROM budget_concurrency_modes WHERE provider_key = ?').get(key)?.mode : undefined;
        const counts = db.prepare(`SELECT COUNT(*) FILTER (WHERE admitted_at > ?) AS hour, COUNT(*) FILTER (WHERE admitted_at > ?) AS day
          FROM budget_reservations WHERE provider_key = ?`).get(now - HOUR, now - DAY, key)!;
        const active = db.prepare(`SELECT owner, admitted_at AS admittedAt FROM budget_reservations
          WHERE provider_key = ? AND released = 0 ORDER BY admitted_at, token`).all(key)
          .map(hold => ({ owner: String(hold.owner), admittedAt: Number(hold.admittedAt) }));
        const waiters = hasWaiters ? db.prepare(`SELECT COUNT(*) FILTER (WHERE priority >= 1) AS normal, COUNT(*) FILTER (WHERE priority < 1) AS low
          FROM budget_waiters WHERE provider_key = ? AND seen_at > ?`).get(key, now - WAITER_LEASE_MS) : undefined;
        const pausedUntil = Number(row.paused_until);
        return {
          providerKey: key,
          concurrency: mode === 'unlimited' ? { mode: 'unlimited' } : { mode: 'limited', maxConcurrent: Number(row.max_concurrent) },
          maxLaunchesPerHour: Number(row.max_hour), maxLaunchesPerDay: Number(row.max_day),
          launchesLastHour: Number(counts.hour), launchesLastDay: Number(counts.day),
          pausedUntil: pausedUntil > now ? pausedUntil : null,
          active,
          waiting: { normal: Number(waiters?.normal ?? 0), low: Number(waiters?.low ?? 0) },
        };
      });
      return { ok: true, readAt: now, providers };
    } finally { db.exec('COMMIT'); }
  } catch { return { ok: false, reason: 'unavailable' }; }
  finally { try { db.close(); } catch { /* already closed */ } }
}
