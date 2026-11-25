import type { DatabaseSync } from 'node:sqlite';
import type { LaunchPriority } from './host-types.ts';
import { identifier } from './validation.ts';

/**
 * How long a waiter's declaration counts without being renewed. A waiting `acquire` renews it on
 * every attempt, and attempts are at most 30 seconds apart, so only a process that died or stalled
 * lets it lapse. A lapsed declaration gives up precedence; it never frees or grants a slot.
 */
export const WAITER_LEASE_MS = 90_000;

/** Higher rank is served first. Stored as a number so a further level is an additive change. */
const RANK: Readonly<Record<LaunchPriority, number>> = Object.freeze({ low: 0, normal: 1 });
const TOP_RANK = RANK.normal;

/**
 * Additive migration: one table created on first use inside the caller's transaction. The ledger
 * stays at `user_version` 1, so a process on an older build keeps sharing the same file. That
 * older process neither declares its waits nor yields to anyone.
 */
export const WAITERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_waiters (
  waiter TEXT PRIMARY KEY NOT NULL CHECK(length(waiter) BETWEEN 1 AND 256),
  provider_key TEXT NOT NULL REFERENCES budget_providers(provider_key),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 255),
  seen_at INTEGER NOT NULL CHECK(seen_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX IF NOT EXISTS budget_waiters_provider ON budget_waiters(provider_key, priority);`;

/** One admission attempt's place in line. `waiter` is present only while the caller will wait. */
export interface LaunchTurn {
  priority: LaunchPriority;
  waiter?: string;
}

export function isLaunchPriority(value: unknown): value is LaunchPriority {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

export function validTurn(turn: LaunchTurn): boolean {
  return isLaunchPriority(turn.priority) && (turn.waiter === undefined || identifier(turn.waiter));
}

/** Records or renews this waiter's place and drops declarations whose lease lapsed. */
export function declareWaiter(db: DatabaseSync, providerKey: string, turn: LaunchTurn, now: number): void {
  if (turn.waiter === undefined) return;
  db.exec(WAITERS_SCHEMA);
  db.prepare('DELETE FROM budget_waiters WHERE seen_at <= ?').run(now - WAITER_LEASE_MS);
  db.prepare(`INSERT INTO budget_waiters(waiter, provider_key, priority, seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(waiter) DO UPDATE SET provider_key = excluded.provider_key, priority = excluded.priority, seen_at = excluded.seen_at`)
    .run(turn.waiter, providerKey, RANK[turn.priority], now);
}

/** True when a launch of higher priority is currently waiting for a slot of this provider. */
export function isOutranked(db: DatabaseSync, providerKey: string, turn: LaunchTurn, now: number): boolean {
  const rank = RANK[turn.priority];
  // The top priority yields to nobody: default callers never read or create the table.
  if (rank >= TOP_RANK) return false;
  db.exec(WAITERS_SCHEMA);
  const ahead = db.prepare(`SELECT 1 AS found FROM budget_waiters
    WHERE provider_key = ? AND priority > ? AND seen_at > ? AND waiter <> ? LIMIT 1`)
    .get(providerKey, rank, now - WAITER_LEASE_MS, turn.waiter ?? '');
  return ahead !== undefined;
}

/** Withdraws a declaration. Returns whether one was actually recorded. */
export function forgetWaiter(db: DatabaseSync, waiter: string): boolean {
  db.exec(WAITERS_SCHEMA);
  return db.prepare('DELETE FROM budget_waiters WHERE waiter = ?').run(waiter).changes === 1;
}
