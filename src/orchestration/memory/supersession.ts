import type { DatabaseSync } from 'node:sqlite';
import type { RecordRow } from './records.js';
import { MemoryStoreError } from './store-types.js';

/**
 * Supersession in `SqliteSystemMemory`, applied inside the promotion's transaction.
 *
 * A record's `supersedes` is inert until the record is promoted. Then each id it names must
 * be a live lesson of the record's own scope: stored there, promoted, not withdrawn and not
 * already invalidated. One that is not refuses the whole promotion with INVALID_SUPERSESSION,
 * and the transaction rolls back, so nothing changes. An id is looked up in the record's own
 * scope only: a lesson with that id in another scope is simply not found.
 */

const FIND_IN_SCOPE = 'SELECT * FROM memory_records WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?';

const INVALIDATE = `
UPDATE memory_records SET invalidated_at = ?, invalidated_by = ?
WHERE tenant = ? AND namespace = ? AND subject = ? AND id = ?`;

/** The lessons a promotion of `row` would retire, checked; throws INVALID_SUPERSESSION. */
export function supersededLessons(
  db: DatabaseSync, row: RecordRow, withdrawn: (target: RecordRow) => boolean,
): RecordRow[] {
  if (row.supersedes_json === null) return [];
  const ids = JSON.parse(row.supersedes_json) as string[];
  return ids.map(id => {
    const target = db.prepare(FIND_IN_SCOPE).get(row.tenant, row.namespace, row.subject, id) as RecordRow | undefined;
    if (!target || target.promoted_at === null || target.invalidated_at !== null || withdrawn(target)) {
      throw new MemoryStoreError('INVALID_SUPERSESSION');
    }
    return target;
  });
}

/** Marks each lesson invalidated by `by` at `at`: final, audited, never a deletion. */
export function invalidateLessons(db: DatabaseSync, lessons: readonly RecordRow[], by: string, at: string): void {
  const statement = db.prepare(INVALIDATE);
  for (const lesson of lessons) statement.run(at, by, lesson.tenant, lesson.namespace, lesson.subject, lesson.id);
}
