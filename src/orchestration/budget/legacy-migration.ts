import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { absolutePath, identifier, integer } from './validation.ts';

export interface LegacyMigrationSource { databasePath: string; ownerPrefix: string }
export interface LegacyMigrationOptions extends LegacyMigrationSource {
  expectedDigest: string;
  /** Trusted operator acknowledgement; the ledger cannot prove process termination. */
  sourceStoppedConfirmed: true;
}
interface LegacyProvider { providerKey: string; pausedUntil: number; observedAt: number; prunedThrough: number }
interface LegacyReservation { token: string; providerKey: string; owner: string; admittedAt: number; released: number }
export interface LegacySnapshot {
  databasePath: string; sourceDigest: string; identity: { dev: number; ino: number };
  providers: LegacyProvider[]; reservations: LegacyReservation[];
}
export const legacyKey = (path: string, prefix: string) => createHash('sha256').update(JSON.stringify([path, prefix])).digest('hex');
export const legacyToken = (key: string, token: string) => `legacy:${createHash('sha256').update(JSON.stringify([key, token])).digest('hex')}`;
export const LEGACY_MIGRATIONS = `CREATE TABLE IF NOT EXISTS budget_legacy_migrations (
  migration_key TEXT PRIMARY KEY, source_digest TEXT NOT NULL, imported_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS budget_legacy_imported_tokens (token TEXT PRIMARY KEY NOT NULL) STRICT;`;

/** Read-only snapshot of the version-1 budget protocol, never a migration or source rewrite. */
export function readLegacySnapshot(databasePath: string): LegacySnapshot {
  absolutePath(databasePath);
  const before = lstatSync(databasePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024) throw new Error('Legacy ledger must be a bounded regular file');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN;');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x4f415242
      || db.prepare('PRAGMA user_version').get()?.user_version !== 1
      || db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').get() !== undefined) throw new Error('Unrecognized or corrupt legacy ledger');
    const hasPruning = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='budget_pruning_state'").get();
    const pruning = new Map(hasPruning ? db.prepare('SELECT provider_key,pruned_through FROM budget_pruning_state LIMIT 1001').all()
      .map(row => {
        if (!identifier(row.provider_key) || !integer(row.pruned_through)) throw new Error('Invalid legacy pruning state');
        return [row.provider_key, row.pruned_through] as const;
      }) : []);
    if (pruning.size > 1000) throw new Error('Legacy pruning count exceeds migration budget');
    const providers = db.prepare('SELECT * FROM budget_providers ORDER BY provider_key LIMIT 1001').all().map(row => {
      if (!identifier(row.provider_key) || !['max_concurrent', 'max_hour', 'max_day', 'paused_until', 'last_observed_at'].every(key => integer(row[key]))
        || !integer(row.cooldown_ms, 1)) throw new Error('Invalid legacy provider state');
      return { providerKey: row.provider_key, pausedUntil: Number(row.paused_until), observedAt: Number(row.last_observed_at),
        prunedThrough: pruning.get(row.provider_key) ?? Math.max(0, Number(row.last_observed_at) - 86_400_000) };
    });
    if (providers.length > 1000) throw new Error('Legacy provider count exceeds migration budget');
    const known = new Set(providers.map(row => row.providerKey));
    const reservations = db.prepare('SELECT * FROM budget_reservations ORDER BY token LIMIT 100001').all().map(row => {
      if (!identifier(row.token) || !identifier(row.provider_key) || !known.has(row.provider_key) || !identifier(row.owner)
        || !integer(row.admitted_at) || ![0, 1].includes(Number(row.released))) throw new Error('Invalid legacy reservation');
      return { token: row.token, providerKey: row.provider_key, owner: row.owner, admittedAt: Number(row.admitted_at), released: Number(row.released) };
    });
    if (reservations.length > 100000) throw new Error('Legacy reservation count exceeds migration budget');
    const after = lstatSync(databasePath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('Legacy ledger replaced during inspection');
    const sourceDigest = createHash('sha256').update(JSON.stringify({ providers, reservations })).digest('hex');
    return { databasePath, sourceDigest, providers, reservations, identity: { dev: before.dev, ino: before.ino } };
  } finally { db.close(); }
}

/** Safe to display: contains counts and a digest, never bearer tokens or run owners. */
export function inspectLegacyLaunchBudget(databasePath: string) {
  const snapshot = readLegacySnapshot(databasePath);
  return { sourceDigest: snapshot.sourceDigest, providers: snapshot.providers.map(provider => {
    const rows = snapshot.reservations.filter(row => row.providerKey === provider.providerKey);
    return { providerKey: provider.providerKey, reservations: rows.length, active: rows.filter(row => !row.released).length };
  }) };
}
