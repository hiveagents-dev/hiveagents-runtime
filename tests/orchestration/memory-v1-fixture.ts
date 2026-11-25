import { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../src/shared/json.js';
import { contentDigest } from '../../src/orchestration/memory/records.js';
import { MEMORY_SCHEMA_V1 } from '../../src/orchestration/memory/schema.js';
import { captureRecord } from '../../src/orchestration/memory/validation.js';
import type { ScopedMemoryRecord } from '../../src/orchestration/memory/index.js';
import { passingGate } from './memory-store-fixture.js';

/**
 * A memory file as the build before temporal validity (c585264) left it, and the statements
 * that build runs, copied verbatim from its store, so a test can play an older process on the
 * same machine against a file this build opened.
 */
export const V1_COLUMNS = `tenant, namespace, subject, id, text, content_digest, provenance_json, source_id, source_sequence,
  source_digest, input_hash, metadata_json, embedding_identity, embedding_json, recorded_at`;

export const OLD_BUILD = {
  /** Its open check: anything else is UNSUPPORTED_DATABASE. */
  opens: (db: DatabaseSync) => db.prepare('PRAGMA application_id').get()?.application_id === 0x4f41524d
    && db.prepare('PRAGMA user_version').get()?.user_version === 1,
  insert: `INSERT INTO memory_records (${V1_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  promote: `UPDATE memory_records SET promoted_at = ?, promoted_by = ?, gate_json = ?
    WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?`,
  revoke: `UPDATE memory_records SET revoked_at = ?, revoked_reason = ?
    WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?`,
  rollback: `UPDATE memory_records SET rolled_back_at = ?, rolled_back_by = ?, rollback_reason = ?
    WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?`,
  enable: `INSERT INTO memory_systems (system_id, enabled, changed_by, changed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(system_id) DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
  grant: `INSERT INTO memory_grants (grant_id, owner, grantee, namespace, subject, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  revokeGrant: 'UPDATE memory_grants SET revoked_at = ?, revoked_by = ? WHERE grant_id = ?',
  recall: `SELECT r.* FROM memory_readable r
    WHERE r.tenant = ?1 AND r.namespace = ?2 AND r.subject = ?3
      AND r.promoted_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM memory_systems s WHERE s.system_id = ?4 AND s.enabled = 1)
      AND (r.tenant = ?4 OR EXISTS (
        SELECT 1 FROM memory_usable_grants g
        WHERE g.owner = r.tenant AND g.grantee = ?4 AND g.namespace = r.namespace AND g.subject = r.subject))
    ORDER BY r.promoted_at DESC, r.id LIMIT 512`,
  viewCounts: `SELECT r.tenant AS id, COUNT(*) AS observations, COUNT(r.promoted_at) AS lessons
    FROM memory_records r WHERE r.revoked_at IS NULL AND r.rolled_back_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM memory_withdrawn_entries w WHERE w.tenant = r.tenant AND w.source_id = r.source_id AND w.source_sequence = r.source_sequence)
    GROUP BY r.tenant`,
} as const;

/** The column values the older build's `put` writes for an episode (no logPosition, no embedding). */
export function oldInsertValues(record: ScopedMemoryRecord, recordedAt: string): (string | number | null)[] {
  const captured = captureRecord(record);
  return [
    captured.scope.tenant, captured.scope.namespace, captured.scope.subject, captured.id, captured.text,
    contentDigest(captured), canonical(captured.provenance), null, null, null, captured.provenance.inputHash ?? null,
    captured.metadata === undefined ? null : canonical(captured.metadata), null, null, recordedAt,
  ];
}

/** The older build's promotion of `id` in `grow/lessons`, with a passing gate that names its digest. */
export function oldPromote(db: DatabaseSync, id: string, at: string): void {
  const digest = db.prepare("SELECT content_digest FROM memory_records WHERE tenant = 'grow' AND id = ?").get(id)!.content_digest as string;
  db.prepare(OLD_BUILD.promote).run(at, 'operator', canonical(passingGate(digest)), 'grow', 'lessons', '', id);
}

/**
 * A file written with the schema 1 DDL exactly as it shipped: one lesson, one episode, one
 * revoked record and one grant, in the older build's column layout.
 */
export function writeV1Database(path: string, episode: (tenant: string, id: string, text: string) => ScopedMemoryRecord): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`BEGIN IMMEDIATE; ${MEMORY_SCHEMA_V1} COMMIT;`);
    db.prepare(OLD_BUILD.enable).run('grow', 1, 'operator', '2026-11-01T00:00:00.000Z');
    db.prepare(OLD_BUILD.enable).run('marketing', 1, 'operator', '2026-11-01T00:00:00.000Z');
    for (const [id, text] of [['leccion', 'factura en pesos'], ['borrador', 'factura sin medir'], ['olvidado', 'factura secreta']] as const) {
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', id, text), '2026-11-01T00:00:01.000Z'));
    }
    oldPromote(db, 'leccion', '2026-11-01T00:00:02.000Z');
    db.prepare(OLD_BUILD.revoke).run('2026-11-01T00:00:03.000Z', 'pedido', 'grow', 'lessons', '', 'olvidado');
    db.prepare(OLD_BUILD.grant).run('g1', 'grow', 'marketing', 'lessons', '', 'operator', '2026-11-01T00:00:04.000Z');
  } finally { db.close(); }
}

export function pragmas(path: string) {
  const db = new DatabaseSync(path);
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()!.user_version,
      application: db.prepare('PRAGMA application_id').get()!.application_id,
      columns: db.prepare("SELECT name FROM pragma_table_info('memory_records')").all().map(row => String(row.name)),
      schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
    };
  } finally { db.close(); }
}
