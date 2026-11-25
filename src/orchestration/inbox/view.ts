import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inboxCard } from './card.js';
import { CLOCK_ACTOR, readRequest, readTransitions, toItem } from './rows.js';
import { isInboxDatabase } from './sqlite.js';
import type { InboxCard, InboxItem, InboxOutcome, InboxStatus, InboxView, InboxViewOptions } from './types.js';

const SQLITE_NOTADB = 26;

type Unreadable = 'absent' | 'unrecognized' | 'unavailable';

/**
 * Opens the inbox for reading only. Never creates, migrates or repairs the file, and never
 * follows a link: like the writers, it only accepts a regular file at that exact path.
 */
function openReadOnly(databasePath: string): { ok: true; db: DatabaseSync } | { ok: false; reason: Unreadable } {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)) throw new TypeError('databasePath must be an absolute path');
  try {
    if (!lstatSync(databasePath).isFile()) return { ok: false, reason: 'unrecognized' };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable' };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    db.exec('PRAGMA busy_timeout = 250; PRAGMA query_only = ON;');
    if (isInboxDatabase(db)) return { ok: true, db };
    db.close();
    return { ok: false, reason: 'unrecognized' };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    const code = error instanceof Error && 'errcode' in error ? Number(error.errcode) & 255 : undefined;
    return { ok: false, reason: code === SQLITE_NOTADB ? 'unrecognized' : 'unavailable' };
  }
}

function limit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('View limits must be non-negative integers');
  return Math.min(value, max);
}

interface OpenRow {
  request_id: string;
  status: 'pending' | 'approved';
  requested_at: number;
  expires_at: number | null;
  approval_expires_at: number | null;
  changed_at: number;
}

/** A request that left the queue: which one, in what state, since when and by whom. */
interface Settled {
  requestId: string;
  status: Exclude<InboxStatus, 'pending'>;
  at: number;
  /** Set when the state is derived from a passed deadline that no writer has recorded yet. */
  derived?: true;
}

function settledOpenRow(row: OpenRow, now: number): Settled | undefined {
  const due = row.status === 'pending' ? row.expires_at : row.approval_expires_at;
  if (due !== null && due <= now) return { requestId: row.request_id, status: 'expired', at: due, derived: true };
  if (row.status === 'approved') return { requestId: row.request_id, status: 'approved', at: row.changed_at };
  return undefined;
}

/**
 * What the decision inbox holds right now, for a screen: the pending requests of every system in
 * one list, oldest first, and the latest outcomes. It opens the file read-only, so it can never
 * approve, expire or change anything, and it answers `absent`, `unrecognized` or `unavailable`
 * instead of throwing when the file is missing, is not an inbox or cannot be read.
 *
 * A request whose deadline has passed is shown as expired even if no writer has recorded it yet.
 * Throws `TypeError` only for a programming error: a relative path, or a time or limit that is
 * not a non-negative integer.
 */
export function readInboxView(databasePath: string, options: InboxViewOptions = {}): InboxView {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a time in epoch milliseconds');
  const pendingLimit = limit(options.pendingLimit, 100, 500);
  const recentLimit = limit(options.recentLimit, 20, 200);
  const opened = openReadOnly(databasePath);
  if (!opened.ok) return opened;
  const { db } = opened;
  try {
    db.exec('BEGIN');
    try {
      // Open requests are few by construction: each system has a cap on how many it may hold.
      const open = db.prepare(`SELECT request_id, status, requested_at, expires_at, approval_expires_at, changed_at
        FROM inbox_requests WHERE status IN ('pending', 'approved') ORDER BY requested_at, request_id`).all() as unknown as OpenRow[];
      const waiting: OpenRow[] = [];
      const settled: Settled[] = [];
      for (const row of open) {
        const outcome = settledOpenRow(row, now);
        if (outcome) settled.push(outcome);
        else waiting.push(row);
      }
      const closed = db.prepare(`SELECT request_id, status, changed_at FROM inbox_requests
        WHERE status NOT IN ('pending', 'approved') ORDER BY changed_at DESC, request_id LIMIT ?`).all(recentLimit);
      for (const row of closed) {
        settled.push({ requestId: String(row.request_id), status: row.status as Settled['status'], at: Number(row.changed_at) });
      }
      settled.sort((left, right) => right.at - left.at || left.requestId.localeCompare(right.requestId));

      let damaged = 0;
      const load = (requestId: string): InboxItem | undefined => {
        const row = readRequest(db, requestId);
        const item = row ? toItem(row, readTransitions(db, requestId)) : undefined;
        if (!item) damaged += 1;
        return item;
      };

      const pending: InboxCard[] = [];
      for (const row of waiting.slice(0, pendingLimit)) {
        const item = load(row.request_id);
        if (item) pending.push(inboxCard(item));
      }
      const recent: InboxOutcome[] = [];
      for (const entry of settled.slice(0, recentLimit)) {
        const item = load(entry.requestId);
        if (!item) continue;
        const last = item.transitions.at(-1);
        recent.push({
          ...inboxCard(item),
          status: entry.status,
          at: entry.at,
          by: entry.derived ? CLOCK_ACTOR : last?.by ?? '',
          ...(entry.derived || last?.note === undefined ? {} : { note: last.note }),
          wasApproved: item.transitions.some((transition) => transition.to === 'approved'),
          approvalExpiresAt: item.approvalExpiresAt,
        });
      }
      return { ok: true, readAt: now, pending, pendingTotal: waiting.length, recent, damaged };
    } finally {
      db.exec('COMMIT');
    }
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * One request in full, for a detail panel: the whole payload and every recorded transition.
 * Read-only, and it never throws for a missing or foreign file.
 */
export function readInboxItem(databasePath: string, requestId: string):
  { ok: true; item: InboxItem } | { ok: false; reason: Unreadable | 'unknown-request' | 'integrity' } {
  const opened = openReadOnly(databasePath);
  if (!opened.ok) return opened;
  const { db } = opened;
  try {
    db.exec('BEGIN');
    try {
      const row = typeof requestId === 'string' ? readRequest(db, requestId) : undefined;
      if (!row) return { ok: false, reason: 'unknown-request' };
      const item = toItem(row, readTransitions(db, row.request_id));
      return item ? { ok: true, item } : { ok: false, reason: 'integrity' };
    } finally {
      db.exec('COMMIT');
    }
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}
