import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { InboxInputError, bindDisplay, captureAction, inboxIdentifier } from './action.js';
import { CLOCK_ACTOR, readRequest, readTransitions, recordTransition, toItem, type RequestRow } from './rows.js';
import { InboxDatabase, isBusyError } from './sqlite.js';
import type {
  InboxApproveInput, InboxApproved, InboxConsumeInput, InboxConsumed, InboxDisplayField, InboxFailure, InboxFiled, InboxItem, InboxRefusal,
  InboxRejectInput, InboxRejected, InboxRequestInput, InboxResult, InboxStatus, InboxWithdrawInput,
} from './types.js';

const MAX_NOTE_LENGTH = 500;
/** No approval may stay usable for longer than this, whatever deadline is asked for. */
export const MAX_APPROVAL_LIFETIME_MS = 30 * 24 * 3_600_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HOUR_MS = 3_600_000;

/** How much one system may ask of the shared file. */
export interface InboxFilingLimits {
  maxOpen: number;
  maxFiledPerHour: number;
}

/** A refusal decided before anything was written; the transaction rolls back. */
export class Refused extends Error {
  readonly failure: InboxFailure;
  constructor(reason: InboxRefusal, detail?: string, status?: InboxStatus) {
    super(detail ?? reason);
    this.failure = { ok: false, reason, ...(detail === undefined ? {} : { detail }), ...(status === undefined ? {} : { status }) };
  }
}

/** What each final state answers to someone who still tries to use or change the request. */
const FINAL_REFUSAL: Readonly<Record<Exclude<InboxStatus, 'pending' | 'approved'>, InboxRefusal>> = {
  consumed: 'already-used',
  rejected: 'rejected',
  expired: 'expired',
  withdrawn: 'withdrawn',
};

export function finalRefusal(status: InboxStatus): InboxRefusal | undefined {
  return status === 'pending' || status === 'approved' ? undefined : FINAL_REFUSAL[status];
}

export function closedInput(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InboxInputError('Input must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !(required.includes(key) || optional.includes(key))) throw new InboxInputError(`Unknown field ${String(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new InboxInputError(`${key} is required`);
  }
  return value as Record<string, unknown>;
}

export function requestIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new InboxInputError('requestId is not a request identifier');
  return value;
}

function deadline(value: unknown, field: string, now: number): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= now) {
    throw new InboxInputError(`${field} must be a time in epoch milliseconds after now`);
  }
  return value;
}

function note(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_NOTE_LENGTH) {
    throw new InboxInputError(`${field} must be a non-empty text of at most ${MAX_NOTE_LENGTH} characters`);
  }
  return value;
}

export interface InboxEngineOptions {
  databasePath: string;
  busyTimeoutMs: number;
  now: () => number;
}

/**
 * The durable queue. Every method is one atomic transaction on the shared file and answers with a
 * result instead of throwing: storage that cannot be trusted refuses, it never approves. Every
 * method, reads included, takes the file's write lock for its few milliseconds; when another
 * process holds it for longer than the busy timeout the answer is `busy` and nothing changed.
 * Each operation first makes every due expiry durable, so the state it reads is current.
 */
export class InboxEngine {
  readonly bellPath: string;
  readonly #now: () => number;
  #database: InboxDatabase | undefined;
  #fault: string | undefined;
  #closed = false;
  /** Set when the running operation changed something a waiter may care about. */
  #rang = false;

  constructor(options: InboxEngineOptions) {
    this.bellPath = `${options.databasePath}.bell`;
    this.#now = options.now;
    try {
      this.#database = new InboxDatabase(options.databasePath, options.busyTimeoutMs);
    } catch (error) {
      this.#fault = error instanceof Error ? error.message : String(error);
    }
  }

  /** The time the engine works with, in epoch ms. */
  now(): number {
    return this.#now();
  }

  /** True when the file was opened as an inbox. False means every operation will refuse. */
  get usable(): boolean {
    return this.#database !== undefined;
  }

  /**
   * Files a request, or returns the open request the same action already has. `declared` maps
   * each action kind the system may file to the card lines it declared for that kind.
   */
  file(
    systemId: string,
    declared: ReadonlyMap<string, readonly InboxDisplayField[]>,
    limits: InboxFilingLimits,
    input: InboxRequestInput,
  ): InboxResult<InboxFiled> {
    return this.#operate<InboxFiled>((db, now) => {
      const fields = closedInput(input, ['actionKind', 'payload', 'requestedBy'], ['effect', 'expiresAt']);
      const action = captureAction({
        systemId,
        actionKind: fields.actionKind,
        payload: fields.payload,
        ...(fields.effect === undefined ? {} : { effect: fields.effect }),
      });
      const lines = declared.get(action.actionKind);
      if (!lines) {
        throw new Refused('undeclared-action', `${action.actionKind} is not an irreversible action declared by ${systemId}`);
      }
      const display = bindDisplay(lines, action.payload);
      const requestedBy = inboxIdentifier(fields.requestedBy, 'requestedBy');
      const expiresAt = deadline(fields.expiresAt, 'expiresAt', now);

      const open = db.prepare(`SELECT request_id, status FROM inbox_requests
        WHERE system_id = ? AND action_hash = ? AND status IN ('pending', 'approved')`).get(systemId, action.hash);
      if (open) {
        return { ok: true, requestId: String(open.request_id), actionHash: action.hash, status: open.status as InboxStatus, created: false };
      }
      const count = db.prepare(`SELECT COUNT(*) AS open FROM inbox_requests
        WHERE system_id = ? AND status IN ('pending', 'approved')`).get(systemId);
      if (Number(count?.open) >= limits.maxOpen) throw new Refused('queue-full', `${systemId} already has ${limits.maxOpen} open requests`);
      const recent = db.prepare('SELECT COUNT(*) AS filed FROM inbox_requests WHERE system_id = ? AND requested_at > ?')
        .get(systemId, now - HOUR_MS);
      if (Number(recent?.filed) >= limits.maxFiledPerHour) {
        throw new Refused('rate-limited', `${systemId} already filed ${limits.maxFiledPerHour} requests in the last hour`);
      }

      const requestId = randomUUID();
      db.prepare(`INSERT INTO inbox_requests(request_id, system_id, action_kind, action_hash, action_json, display_json,
        status, requested_at, expires_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(requestId, systemId, action.actionKind, action.hash, action.json, JSON.stringify(display), now, expiresAt, now);
      recordTransition(db, requestId, null, 'pending', requestedBy, now);
      this.#rang = true;
      return { ok: true, requestId, actionHash: action.hash, status: 'pending', created: true };
    });
  }

  /**
   * A person approves the action whose hash they were shown. The approval always has a deadline:
   * the one given, or `lifetimeMs` from now.
   */
  approve(input: InboxApproveInput, lifetimeMs: number): InboxResult<InboxApproved> {
    return this.#operate<InboxApproved>((db, now) => {
      const fields = closedInput(input, ['requestId', 'actionHash', 'by'], ['expiresAt']);
      const row = this.#pending(db, requestIdentifier(fields.requestId));
      const by = inboxIdentifier(fields.by, 'by');
      const approvalExpiresAt = deadline(fields.expiresAt, 'expiresAt', now) ?? now + lifetimeMs;
      if (approvalExpiresAt > now + MAX_APPROVAL_LIFETIME_MS) {
        throw new InboxInputError('expiresAt may be at most thirty days after now');
      }
      if (!toItem(row, [])) throw new Refused('integrity', 'The stored action no longer matches its hash');
      if (fields.actionHash !== row.action_hash) {
        throw new Refused('action-changed', 'The approved hash is not the hash of the stored action', row.status);
      }
      this.#move(db, row, 'approved', by, now, undefined, approvalExpiresAt);
      return { ok: true, status: 'approved', approvalExpiresAt };
    });
  }

  /**
   * A person says no to a pending request, or takes back an approval nobody used yet. Either way
   * the request can never be approved or used afterwards. It runs under the same write lock as
   * `consume`: if a system used the approval first, the answer is `already-used`.
   */
  reject(input: InboxRejectInput): InboxResult<InboxRejected> {
    return this.#operate<InboxRejected>((db, now) => {
      const fields = closedInput(input, ['requestId', 'by'], ['reason']);
      const row = readRequest(db, requestIdentifier(fields.requestId));
      if (!row) throw new Refused('unknown-request');
      const by = inboxIdentifier(fields.by, 'by');
      const reason = note(fields.reason, 'reason');
      if (row.status !== 'pending' && row.status !== 'approved') {
        const refusal = row.status === 'consumed' || row.status === 'expired' ? FINAL_REFUSAL[row.status] : 'not-pending';
        throw new Refused(refusal, undefined, row.status);
      }
      this.#move(db, row, 'rejected', by, now, reason);
      return { ok: true, status: 'rejected', wasApproved: row.status === 'approved' };
    });
  }

  /** The system gives up a request that is still open. Withdrawing twice is not an error. */
  withdraw(systemId: string, input: InboxWithdrawInput): InboxResult<{ status: 'withdrawn' }> {
    return this.#operate((db, now) => {
      const fields = closedInput(input, ['requestId', 'by'], ['reason']);
      const row = this.#owned(db, requestIdentifier(fields.requestId), systemId);
      const by = inboxIdentifier(fields.by, 'by');
      const reason = note(fields.reason, 'reason');
      if (row.status === 'withdrawn') return { ok: true, status: 'withdrawn' };
      const refusal = finalRefusal(row.status);
      if (refusal) throw new Refused(refusal, undefined, row.status);
      this.#move(db, row, 'withdrawn', by, now, reason);
      return { ok: true, status: 'withdrawn' };
    });
  }

  /**
   * Uses an approval. The read of the state, the comparison with the presented action and the
   * move to `consumed` happen under one write lock, so of any number of processes exactly one
   * succeeds. A refused attempt changes no state; it is counted on the request.
   */
  consume(systemId: string, input: InboxConsumeInput): InboxResult<InboxConsumed> {
    return this.#operate<InboxConsumed>((db, now) => {
      const fields = closedInput(input, ['requestId', 'actionKind', 'payload', 'by'], ['effect']);
      const row = this.#owned(db, requestIdentifier(fields.requestId), systemId);
      const by = inboxIdentifier(fields.by, 'by');
      const refusal = this.#whyNotUsable(row, systemId, fields);
      const approval = db.prepare(`SELECT actor, at FROM inbox_transitions
        WHERE request_id = ? AND to_status = 'approved' ORDER BY sequence DESC LIMIT 1`).get(row.request_id);
      const reason = refusal ?? (approval ? undefined : 'integrity');
      if (reason) {
        db.prepare('UPDATE inbox_requests SET refused_uses = refused_uses + 1, last_refused_json = ? WHERE request_id = ?')
          .run(JSON.stringify({ at: now, by, reason }), row.request_id);
        return { ok: false, reason, status: row.status };
      }
      this.#move(db, row, 'consumed', by, now);
      return {
        ok: true,
        consumedAt: now,
        approvedBy: String(approval!.actor),
        approvedAt: Number(approval!.at),
        approvalExpiresAt: row.approval_expires_at,
      };
    });
  }

  /** Everything stored about one request. With `systemId`, only that system's requests exist. */
  inspect(requestId: string, systemId?: string): InboxResult<{ item: InboxItem }> {
    return this.#operate((db) => {
      const id = requestIdentifier(requestId);
      const row = systemId === undefined ? readRequest(db, id) : this.#owned(db, id, systemId);
      if (!row) throw new Refused('unknown-request');
      const item = toItem(row, readTransitions(db, id));
      if (!item) throw new Refused('integrity', 'The stored action no longer matches its hash');
      return { ok: true, item };
    });
  }

  /** Makes every due expiry durable and says how many requests expired now. */
  sweep(): InboxResult<{ expired: number }> {
    return this.#operate((_db, _now, expired) => ({ ok: true, expired }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
  }

  /** Why this request cannot be used for the presented action, or nothing when it can. */
  #whyNotUsable(row: RequestRow, systemId: string, fields: Record<string, unknown>): InboxRefusal | undefined {
    if (row.status === 'pending') return 'not-approved';
    if (row.status !== 'approved') return finalRefusal(row.status);
    const presented = captureAction({
      systemId,
      actionKind: fields.actionKind,
      payload: fields.payload,
      ...(fields.effect === undefined ? {} : { effect: fields.effect }),
    });
    if (presented.hash !== row.action_hash || presented.json !== row.action_json) return 'action-changed';
    return toItem(row, []) ? undefined : 'integrity';
  }

  #owned(db: DatabaseSync, requestId: string, systemId: string): RequestRow {
    const row = readRequest(db, requestId);
    // Another system's request answers exactly like one that does not exist.
    if (!row || row.system_id !== systemId) throw new Refused('unknown-request');
    return row;
  }

  #pending(db: DatabaseSync, requestId: string): RequestRow {
    const row = readRequest(db, requestId);
    if (!row) throw new Refused('unknown-request');
    if (row.status !== 'pending') throw new Refused(row.status === 'expired' ? 'expired' : 'not-pending', undefined, row.status);
    return row;
  }

  #move(db: DatabaseSync, row: RequestRow, to: InboxStatus, by: string, at: number, text?: string, approvalExpiresAt: number | null = null): void {
    // The WHERE repeats the state this decision was made on; the schema trigger refuses the rest.
    const changed = db.prepare(`UPDATE inbox_requests SET status = ?, approval_expires_at = COALESCE(?, approval_expires_at)
      WHERE request_id = ? AND status = ?`).run(to, approvalExpiresAt, row.request_id, row.status);
    if (changed.changes !== 1) throw new Error('The request changed under its own transaction');
    recordTransition(db, row.request_id, row.status, to, by, at, text);
    this.#rang = true;
  }

  #expireDue(db: DatabaseSync, now: number): number {
    const due = db.prepare(`SELECT request_id, status FROM inbox_requests
      WHERE (status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?)
         OR (status = 'approved' AND approval_expires_at IS NOT NULL AND approval_expires_at <= ?)`).all(now, now);
    for (const entry of due) {
      const row = readRequest(db, String(entry.request_id));
      if (!row) continue;
      const why = row.status === 'pending' ? 'Nobody answered before the deadline' : 'The approval was not used before its deadline';
      this.#move(db, row, 'expired', CLOCK_ACTOR, now, why);
    }
    return due.length;
  }

  #operate<T>(work: (db: DatabaseSync, now: number, expired: number) => InboxResult<T>): InboxResult<T> {
    if (this.#closed) return { ok: false, reason: 'closed' };
    if (!this.#database) return { ok: false, reason: 'storage-unavailable', ...(this.#fault === undefined ? {} : { detail: this.#fault }) };
    const database = this.#database;
    this.#rang = false;
    let result: InboxResult<T>;
    try {
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_SAFE) throw new Error('The clock did not return a time in epoch milliseconds');
      result = database.transaction((db) => {
        const expired = this.#expireDue(db, now);
        try {
          return work(db, now, expired);
        } catch (error) {
          // A refusal found after expiries were written keeps them: the refusal is the answer,
          // the expiries are facts. Anything else rolls the whole transaction back.
          if (expired > 0 && (error instanceof Refused || error instanceof InboxInputError)) return refusalOf(error);
          throw error;
        }
      });
    } catch (error) {
      this.#rang = false;
      if (error instanceof Refused || error instanceof InboxInputError) return refusalOf(error);
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: isBusyError(error) ? 'busy' : 'storage-unavailable', detail };
    }
    if (this.#rang) this.#ring();
    return result;
  }

  /** A hint for waiters that something changed. They always read the file again. */
  #ring(): void {
    try {
      writeFileSync(this.bellPath, String(process.hrtime.bigint()), { mode: 0o600 });
    } catch {
      // A lost hint only delays a waiter until its backstop.
    }
  }
}

function refusalOf(error: Refused | InboxInputError): InboxFailure {
  return error instanceof Refused ? error.failure : { ok: false, reason: 'invalid-input', detail: error.message };
}
