import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostLedgerPath } from '../budget/host-options.js';

const APPLICATION_ID = 0x4f41524d;
/**
 * The only version there is: temporal validity added columns, not a version (see the store's
 * schema). This view reads a file with or without them and never adds them (the store does, on open).
 */
const SCHEMA_VERSION = 1;

/** The shared memory file of the machine: `OAR_HOST_MEMORY`, or `memory.sqlite` beside the ledger. */
export function hostMemoryPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.OAR_HOST_MEMORY !== undefined) {
    if (!isAbsolute(env.OAR_HOST_MEMORY)) throw new TypeError('OAR_HOST_MEMORY must be an absolute path');
    return env.OAR_HOST_MEMORY;
  }
  return join(dirname(hostLedgerPath(env, platform)), 'memory.sqlite');
}

/** One grant as a screen shows it: `other` is the system on the far side. Names only, never memory text. */
export interface MemoryGrantLine {
  id: string;
  other: string;
  namespace: string;
  subject: string;
  at: number;
  by: string;
  /** True while it can be used: not revoked and both systems have memory on. */
  active: boolean;
  revokedAt?: number;
}

export interface MemorySystemView {
  systemId: string;
  enabled: boolean;
  /** Records still readable (not withdrawn), episodes and lessons together, invalidated and expired ones included. */
  observations: number;
  /**
   * What recall can return right now: promoted records that no newer promoted record has
   * invalidated and whose `validUntil` has not passed at the view's `now`. A file without the
   * temporal columns (never opened by a build that knows them) has neither, so every promoted
   * record there counts.
   */
  lessons: number;
  given: MemoryGrantLine[];
  received: MemoryGrantLine[];
  /** Epoch ms of the last change of the switch; absent when nobody ever switched it. */
  changedAt?: number;
  changedBy?: string;
}

export type MemoryView =
  | { ok: true; readAt: number; systems: MemorySystemView[] }
  | { ok: false; reason: 'absent' | 'unrecognized' | 'unavailable' };

const ms = (iso: unknown): number => { const t = Date.parse(String(iso)); return Number.isNaN(t) ? 0 : t; };

/**
 * What the shared memory holds per system, for a screen: switch, counts and grants, never any
 * memory text. Opens the file read-only; never creates, migrates or changes it.
 */
export function readMemoryView(databasePath: string, now: number = Date.now()): MemoryView {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)) throw new TypeError('databasePath must be an absolute path');
  if (!existsSync(databasePath)) return { ok: false, reason: 'absent' };
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath, { readOnly: true }); } catch { return { ok: false, reason: 'unavailable' }; }
  try {
    db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON;');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
      || db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION) return { ok: false, reason: 'unrecognized' };
    db.exec('BEGIN');
    try { return { ok: true, readAt: now, systems: collect(db, now) }; } finally { db.exec('COMMIT'); }
  } catch (error) {
    const code = error instanceof Error && 'errcode' in error ? Number(error.errcode) & 255 : undefined;
    return { ok: false, reason: code === 26 ? 'unrecognized' : 'unavailable' };
  } finally { try { db.close(); } catch { /* already closed */ } }
}

function collect(db: DatabaseSync, now: number): MemorySystemView[] {
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('memory_records')").all().map((row) => String(row.name)));
  const temporal = columns.has('invalidated_at') && columns.has('valid_until');
  // Instants are stored as `toISOString()` gives them, so they compare as strings.
  const lesson = temporal
    ? 'CASE WHEN r.invalidated_at IS NULL AND (r.valid_until IS NULL OR r.valid_until >= ?) THEN r.promoted_at END'
    : 'r.promoted_at';
  const switches = db.prepare('SELECT system_id, enabled, changed_by, changed_at FROM memory_systems').all();
  const enabled = new Set(switches.filter((row) => row.enabled === 1).map((row) => String(row.system_id)));
  const counts = db.prepare(`SELECT r.tenant AS id, COUNT(*) AS observations, COUNT(${lesson}) AS lessons
    FROM memory_records r WHERE r.revoked_at IS NULL AND r.rolled_back_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM memory_withdrawn_entries w WHERE w.tenant = r.tenant AND w.source_id = r.source_id AND w.source_sequence = r.source_sequence)
    GROUP BY r.tenant`).all(...(temporal ? [new Date(now).toISOString()] : []));
  // Ordered as instants: an older build may have stored `granted_at` with a UTC offset.
  const grants = db.prepare('SELECT * FROM memory_grants').all().sort((a, b) =>
    (ms(a.granted_at) - ms(b.granted_at)) || String(a.grant_id).localeCompare(String(b.grant_id)));
  const ids = new Set<string>([...switches.map((r) => String(r.system_id)), ...counts.map((r) => String(r.id)),
    ...grants.flatMap((g) => [String(g.owner), String(g.grantee)])]);
  const line = (g: Record<string, unknown>, other: unknown): MemoryGrantLine => ({
    id: String(g.grant_id), other: String(other), namespace: String(g.namespace), subject: String(g.subject),
    at: ms(g.granted_at), by: String(g.granted_by),
    active: g.revoked_at === null && enabled.has(String(g.owner)) && enabled.has(String(g.grantee)),
    ...(g.revoked_at === null ? {} : { revokedAt: ms(g.revoked_at) }),
  });
  return [...ids].sort().map((systemId): MemorySystemView => {
    const sw = switches.find((r) => String(r.system_id) === systemId);
    const count = counts.find((r) => String(r.id) === systemId);
    return {
      systemId, enabled: enabled.has(systemId),
      observations: Number(count?.observations ?? 0), lessons: Number(count?.lessons ?? 0),
      given: grants.filter((g) => g.owner === systemId).map((g) => line(g, g.grantee)),
      received: grants.filter((g) => g.grantee === systemId).map((g) => line(g, g.owner)),
      ...(sw ? { changedAt: ms(sw.changed_at), changedBy: String(sw.changed_by) } : {}),
    };
  });
}
