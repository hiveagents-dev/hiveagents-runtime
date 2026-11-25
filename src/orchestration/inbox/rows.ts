import type { DatabaseSync } from 'node:sqlite';
import { restoreAction, type CapturedAction } from './action.js';
import type { InboxDisplayField, InboxItem, InboxRefusedUse, InboxStatus, InboxTransition } from './types.js';

/** Who a transition made by the clock is attributed to. */
export const CLOCK_ACTOR = 'inbox:clock';

export const REQUEST_COLUMNS = `request_id, system_id, action_kind, action_hash, action_json, display_json, status,
  requested_at, expires_at, approval_expires_at, changed_at, refused_uses, last_refused_json`;

/** A stored request, as SQLite returns it. */
export interface RequestRow {
  request_id: string;
  system_id: string;
  action_kind: string;
  action_hash: string;
  action_json: string;
  display_json: string;
  status: InboxStatus;
  requested_at: number;
  expires_at: number | null;
  approval_expires_at: number | null;
  changed_at: number;
  refused_uses: number;
  last_refused_json: string | null;
}

export function readRequest(db: DatabaseSync, requestId: string): RequestRow | undefined {
  return db.prepare(`SELECT ${REQUEST_COLUMNS} FROM inbox_requests WHERE request_id = ?`).get(requestId) as RequestRow | undefined;
}

export function readTransitions(db: DatabaseSync, requestId: string): InboxTransition[] {
  const rows = db.prepare(`SELECT sequence, from_status, to_status, actor, at, note
    FROM inbox_transitions WHERE request_id = ? ORDER BY sequence`).all(requestId);
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    from: (row.from_status ?? null) as InboxStatus | null,
    to: row.to_status as InboxStatus,
    by: String(row.actor),
    at: Number(row.at),
    ...(row.note === null ? {} : { note: String(row.note) }),
  }));
}

/** Appends the next transition of a request and stamps the request with the time of the change. */
export function recordTransition(
  db: DatabaseSync,
  requestId: string,
  from: InboxStatus | null,
  to: InboxStatus,
  by: string,
  at: number,
  note?: string,
): void {
  db.prepare(`INSERT INTO inbox_transitions(request_id, sequence, from_status, to_status, actor, at, note)
    VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM inbox_transitions WHERE request_id = ?), ?, ?, ?, ?, ?)`)
    .run(requestId, requestId, from, to, by, at, note ?? null);
  db.prepare('UPDATE inbox_requests SET changed_at = ? WHERE request_id = ?').run(at, requestId);
}

/** The stored display lines, or nothing when the text is not what this code writes. */
export function restoreDisplay(json: string): readonly InboxDisplayField[] | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const lines: InboxDisplayField[] = [];
    for (const entry of parsed) {
      if (typeof entry?.label !== 'string' || !Array.isArray(entry.path) || entry.path.some((segment: unknown) => typeof segment !== 'string')) {
        return undefined;
      }
      lines.push({ label: entry.label, path: entry.path });
    }
    return lines;
  } catch {
    return undefined;
  }
}

function restoreRefusedUse(json: string | null): InboxRefusedUse | undefined {
  if (json === null) return undefined;
  try {
    const parsed = JSON.parse(json) as InboxRefusedUse;
    return { at: Number(parsed.at), by: String(parsed.by), reason: parsed.reason };
  } catch {
    return undefined;
  }
}

/** The full record of a request, or nothing when the stored action fails its own hash. */
export function toItem(row: RequestRow, transitions: readonly InboxTransition[]): InboxItem | undefined {
  const action: CapturedAction | undefined = restoreAction(row.action_json, row.action_hash);
  const display = restoreDisplay(row.display_json);
  if (!action || !display || action.systemId !== row.system_id || action.actionKind !== row.action_kind) return undefined;
  const lastRefusedUse = restoreRefusedUse(row.last_refused_json);
  return {
    requestId: row.request_id,
    systemId: row.system_id,
    actionKind: row.action_kind,
    actionHash: row.action_hash,
    payload: action.payload,
    display,
    ...(action.effect === undefined ? {} : { effect: action.effect }),
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    approvalExpiresAt: row.approval_expires_at,
    refusedUses: row.refused_uses,
    ...(lastRefusedUse === undefined ? {} : { lastRefusedUse }),
    transitions,
  };
}
