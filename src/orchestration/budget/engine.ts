import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { BudgetDatabase, CLOCK_AUDIT_TABLE } from './sqlite.ts';
import { closedRecord, integer, identifier, validateFiniteOptions } from './validation.ts';
import { LEGACY_MIGRATIONS, legacyKey, legacyToken, type LegacySnapshot } from './legacy-migration.ts';
import { validateConcurrency } from './host-options.ts';
import type { HostConcurrency, HostLaunchBudgetStatus, ConcurrencyChange, ConcurrencyPolicy, HostLaunchAdmission, HostRecoveryOptions, HostOwnerLookupOptions, HostOwnerLookup, HostOwnerReservation, HostLedgerIdentity } from './host-types.ts';
import type { SharedLaunchBudgetOptions, LaunchAdmission, BudgetResult, LaunchBudgetStatus,
  LaunchBudgetLimits, BudgetFailure, BudgetDenialReason, LaunchReservation, ClockAcknowledgement } from './types.ts';
import { declareWaiter, forgetWaiter, isOutranked, validTurn, type LaunchTurn } from './priority.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
class Denied extends Error {
  readonly failure: BudgetFailure;
  constructor(reason: BudgetDenialReason, detail?: string, retryAt?: number) {
    super(detail ?? reason);
    this.failure = { reason, ...(detail === undefined ? {} : { detail }), ...(retryAt === undefined ? {} : { retryAt }) };
  }
}

function rollback(row: ProviderRow): Denied {
  return new Denied('clock-rollback', `The system clock is behind the ledger's last observed time ${new Date(row.last_observed_at).toISOString()}`, row.last_observed_at);
}

interface ProviderRow {
  provider_key: string;
  max_concurrent: number;
  max_hour: number;
  max_day: number;
  cooldown_ms: number;
  paused_until: number;
  last_observed_at: number;
}
const CONCURRENCY_MODES = `CREATE TABLE IF NOT EXISTS budget_concurrency_modes (
  provider_key TEXT PRIMARY KEY REFERENCES budget_providers(provider_key),
  mode TEXT NOT NULL CHECK(mode IN ('limited', 'unlimited'))
) STRICT;`;


/**
 * A conservative launch fuse shared by cooperating processes on one local file.
 * It does not infer subscription quota, spend money, or schedule denied work.
 * Every reservation consumes a launch immediately; release only frees concurrency.
 * Active reservations never expire, including after close() or a process crash.
 * Recover a token only after verifying its operation has stopped. This trusted-local
 * coordination primitive is not an authorization boundary against ledger writers.
 */
export class BudgetEngine {
  readonly #modes: ReadonlyMap<string, string>;
  readonly #providers = new Map<string, LaunchBudgetLimits>();
  #database: BudgetDatabase | undefined;
  #fault: string | undefined;
  #closed = false;

  /** Invalid configuration throws before I/O; unavailable storage fails closed in results. */
  constructor(options: SharedLaunchBudgetOptions, modes: ReadonlyMap<string, string> = new Map()) {
    validateFiniteOptions(options);
    this.#modes = modes;
    for (const [key, limits] of Object.entries(options.providers)) this.#providers.set(key, { ...limits });
    const busyTimeoutMs = options.busyTimeoutMs ?? 1000;
    try { this.#database = new BudgetDatabase(options.databasePath, busyTimeoutMs); }
    catch (error) { this.#fault = error instanceof Error ? error.message : String(error); }
  }

  reserve(providerKey: string, owner: string): LaunchAdmission;
  reserve(providerKey: string, owner: string, mayAdmit: (() => boolean) | undefined, turn?: LaunchTurn): HostLaunchAdmission;
  reserve(providerKey: string, owner: string, mayAdmit?: () => boolean, turn?: LaunchTurn): HostLaunchAdmission {
    const result = this.#operate(db => {
      if (!identifier(owner)) throw new Denied('invalid-input', 'Owner must be a nonempty identifier of at most 256 characters');
      const { row, limits, now, mode } = this.#provider(db, providerKey);
      if (mayAdmit && !mayAdmit()) return { allowed: false as const, reason: 'wait-timeout' as const };
      this.#observe(db, row, now);
      const status = this.#status(db, row, limits, now);
      if (turn !== undefined && !validTurn(turn)) throw new Denied('invalid-input', 'Priority must be normal or low');
      // A caller that will wait declares itself first, so a lower priority leaves the next slot to it.
      if (turn !== undefined) declareWaiter(db, providerKey, turn, now);
      let reason: BudgetDenialReason | undefined;
      if (row.paused_until > now) return { allowed: false as const, reason: 'quota-cooldown' as const, retryAt: row.paused_until };
      if (mode !== 'unlimited' && status.active >= limits.maxConcurrent) reason = 'concurrency-limit';
      else if (status.launchesLastHour >= limits.maxLaunchesPerHour) reason = 'hourly-limit';
      else if (status.launchesLastDay >= limits.maxLaunchesPerDay) reason = 'daily-limit';
      if (!reason && turn !== undefined && isOutranked(db, providerKey, turn, now)) {
        return { allowed: false as const, reason: 'concurrency-limit' as const, outranked: true as const };
      }
      if (reason) return { allowed: false as const, reason };
      if (mayAdmit && !mayAdmit()) return { allowed: false as const, reason: 'wait-timeout' as const };
      const reservation: LaunchReservation = { token: randomUUID(), providerKey, owner, admittedAt: now };
      db.prepare('INSERT INTO budget_reservations(token, provider_key, owner, admitted_at) VALUES (?, ?, ?, ?)')
        .run(reservation.token, providerKey, owner, now);
      if (turn?.waiter !== undefined) forgetWaiter(db, turn.waiter);
      return { allowed: true as const, reservation };
    });
    if (!result.ok) { const { ok: _ok, ...failure } = result; return { allowed: false, ...failure }; }
    return result.value;
  }

  /** Withdraws a waiting caller's declaration once it stops waiting. Frees and grants nothing. */
  stopWaiting(waiter: string): BudgetResult<{ withdrawn: boolean }> {
    return this.#flatten(this.#operate(db => {
      if (!identifier(waiter)) throw new Denied('invalid-input', 'Invalid waiter');
      return { withdrawn: forgetWaiter(db, waiter) };
    }));
  }

  /** Idempotent recovery/completion. Unknown tokens free nothing; no launch is refunded. */
  release(token: string): BudgetResult<{ released: boolean }> {
    return this.#flatten(this.#operate(db => {
      if (!identifier(token)) throw new Denied('invalid-input', 'Invalid reservation token');
      const result = db.prepare('UPDATE budget_reservations SET released = 1 WHERE token = ? AND released = 0').run(token);
      return { released: result.changes === 1 };
    }));
  }

  /** Call only after an explicit observed provider quota error. No text heuristics. */
  recordQuotaError(providerKey: string, retryAtMs?: number): BudgetResult<{ pausedUntil: number }> {
    return this.#flatten(this.#operate(db => {
      const { row, limits, now } = this.#provider(db, providerKey);
      this.#observe(db, row, now);
      if (retryAtMs !== undefined && !integer(retryAtMs)) throw new Denied('invalid-input', 'Invalid quota reset timestamp');
      const pausedUntil = Math.max(row.paused_until, now + limits.quotaCooldownMs, retryAtMs ?? 0);
      if (!integer(pausedUntil)) throw new Denied('invalid-input', 'Cooldown would exceed the safe timestamp range');
      db.prepare('UPDATE budget_providers SET paused_until = ? WHERE provider_key = ?').run(pausedUntil, providerKey);
      return { pausedUntil };
    }));
  }

  /** Read-only: compares the clock with the ledger's mark but never advances it. */
  status(providerKey: string): BudgetResult<{ status: LaunchBudgetStatus }> {
    return this.#flatten(this.#operate(db => {
      const { row, limits, now } = this.#provider(db, providerKey);
      if (now < row.last_observed_at) throw rollback(row);
      return { status: this.#status(db, row, limits, now) };
    }));
  }

  hostStatus(providerKey: string): BudgetResult<{status: HostLaunchBudgetStatus}> {
    return this.#flatten(this.#operate(db => {
      const { row, limits, now, mode } = this.#provider(db, providerKey);
      if (now < row.last_observed_at) throw rollback(row);
      const status = this.#status(db, row, limits, now);
      const {maxConcurrent, ...windows} = limits;
      const concurrency: HostConcurrency = mode === 'unlimited' ? {mode} : {mode:'limited', maxConcurrent};
      return {status: {...status, limits: {...windows, concurrency}}};
    }));
  }

  /** One revision per provider. Ordinary admissions never replace an existing operator policy. */
  concurrencyPolicy(providerKey: string, change?: ConcurrencyChange): BudgetResult<{policy: ConcurrencyPolicy}> {
    return this.#flatten(this.#operate(db => {
      if (!identifier(providerKey)) throw new Denied('invalid-input');
      if (change !== undefined) {
        if (types.isProxy(change) || !closedRecord(change, ['expectedRevision','concurrency']) || !integer(change.expectedRevision) || types.isProxy(change.concurrency))
          throw new Denied('invalid-input');
        try { validateConcurrency(change.concurrency); } catch { throw new Denied('invalid-input'); }
      }
      // The operator can inspect or edit an existing registered account with custom window limits.
      let row = db.prepare('SELECT max_concurrent FROM budget_providers WHERE provider_key=?').get(providerKey);
      if (!row) row = {max_concurrent: this.#provider(db, providerKey).row.max_concurrent};
      db.exec(CONCURRENCY_MODES);
      db.exec(`CREATE TABLE IF NOT EXISTS budget_concurrency_revisions (
        provider_key TEXT PRIMARY KEY REFERENCES budget_providers(provider_key),
        revision INTEGER NOT NULL CHECK(revision > 0)
      ) STRICT;`);
      const mode = db.prepare('SELECT mode FROM budget_concurrency_modes WHERE provider_key=?').get(providerKey)?.mode ?? 'limited';
      const revision = Number(db.prepare('SELECT revision FROM budget_concurrency_revisions WHERE provider_key=?').get(providerKey)?.revision ?? 0);
      if (!integer(revision) || !integer(row.max_concurrent) || !['limited','unlimited'].includes(String(mode))
        || mode === 'unlimited' && row.max_concurrent !== 0) throw Error('Invalid stored concurrency policy');
      const current: HostConcurrency = mode === 'unlimited' ? {mode} : {mode:'limited',maxConcurrent:Number(row.max_concurrent)};
      if (!change) return {policy:{revision,concurrency:current}};
      const next = change.concurrency;
      const same = next.mode === 'unlimited'
        ? current.mode === 'unlimited'
        : current.mode === 'limited' && current.maxConcurrent === next.maxConcurrent;
      // An exact repeated update is already satisfied even if the commit acknowledgement was lost.
      if (same && (revision === change.expectedRevision || revision === change.expectedRevision + 1)) return {policy:{revision,concurrency:current}};
      if (revision !== change.expectedRevision) throw new Denied('configuration-mismatch', 'Concurrency policy revision changed');
      if (!Number.isSafeInteger(revision + 1)) throw new Denied('invalid-input','Concurrency revision exhausted');
      db.prepare('UPDATE budget_providers SET max_concurrent=? WHERE provider_key=?').run(next.mode === 'limited' ? next.maxConcurrent : 0, providerKey);
      db.prepare('INSERT INTO budget_concurrency_modes(provider_key, mode) VALUES(?,?) ON CONFLICT(provider_key) DO UPDATE SET mode=excluded.mode').run(providerKey,next.mode);
      db.prepare('INSERT INTO budget_concurrency_revisions(provider_key, revision) VALUES(?,?) ON CONFLICT(provider_key) DO UPDATE SET revision=excluded.revision').run(providerKey,revision + 1);
      return {policy:{revision:revision + 1,concurrency:{...next}}};
    }));
  }

  /** Exact bounded inspection, including retained released rows. Absence never proves an old acquisition cannot commit. */
  lookupOwner(providerKey: string, owner: string, options: HostOwnerLookupOptions): BudgetResult<HostOwnerLookup> {
    return this.#flatten(this.#operate(db => {
      if (!identifier(owner) || !options || types.isProxy(options) || !closedRecord(options, ['limit'])
        || !integer(options.limit, 1) || options.limit > 100) throw new Denied('invalid-input', 'Exact owner and lookup limit 1..100 required');
      const { row, now } = this.#provider(db, providerKey);
      if (now < row.last_observed_at) throw rollback(row);
      const found = db.prepare(`SELECT token, provider_key AS providerKey, owner, admitted_at AS admittedAt, released
        FROM budget_reservations WHERE provider_key = ? AND owner = ? ORDER BY admitted_at, token LIMIT ?`)
        .all(providerKey, owner, options.limit + 1);
      const reservations = found.slice(0, options.limit).map(value => Object.freeze({ token: value.token as string,
        providerKey: value.providerKey as string, owner: value.owner as string, admittedAt: value.admittedAt as number,
        released: value.released === 1 }) satisfies HostOwnerReservation);
      return { reservations: Object.freeze(reservations), truncated: found.length > options.limit };
    }));
  }

  storageIdentity(): BudgetResult<{ identity: HostLedgerIdentity }> {
    const result = this.#flatten(this.#operate(() => ({ identity: Object.freeze({ format: 1 as const,
      digest: this.#database!.storageDigest() }) })));
    // Filesystem error messages can contain the private database path.
    return result.ok ? result : { ok: false, reason: result.reason };
  }

  /**
   * Explicit operator recovery from `clock-rollback` (a date advanced for a test and restored).
   * Moves the ledger's observed time to now. Nothing is refunded: every reservation stays held,
   * future-dated launches keep counting against the rolling windows and an active cooldown keeps
   * pausing. If pruning already removed history the current window could need, acknowledgement
   * is refused until that window expires; legacy ledgers conservatively assume possible pruning.
   * The acknowledgement is recorded in the ledger itself.
   */
  acknowledgeClock(providerKey: string, acknowledgement: ClockAcknowledgement): BudgetResult<{ previousObservedAt: number; acknowledgedAt: number }> {
    return this.#flatten(this.#operate(db => {
      if (!closedRecord(acknowledgement, ['operatorConfirmed']) || acknowledgement.operatorConfirmed !== true) {
        throw new Denied('invalid-input', 'Explicitly confirm that an operator verified the system clock');
      }
      const { row, now } = this.#provider(db, providerKey);
      const history = db.prepare('SELECT pruned_through FROM budget_pruning_state WHERE provider_key = ?').get(providerKey);
      if (history && Number(history.pruned_through) > now - DAY) {
        const safeAt = Number(history.pruned_through) + DAY;
        throw new Denied('clock-rollback', 'Pruned launch history may still belong to the current budget window; acknowledgement cannot refund it', Number.isSafeInteger(safeAt) ? safeAt : undefined);
      }
      db.exec(CLOCK_AUDIT_TABLE);
      db.prepare('INSERT INTO budget_clock_acknowledgements(provider_key, previous_observed_at, acknowledged_at, pid) VALUES (?, ?, ?, ?)')
        .run(providerKey, row.last_observed_at, now, process.pid);
      db.prepare('UPDATE budget_providers SET last_observed_at = ? WHERE provider_key = ?').run(now, providerKey);
      return { previousObservedAt: row.last_observed_at, acknowledgedAt: now };
    }));
  }

  /** Exact inspected bearer tokens only; no prefix sweep or automatic owner inference. */
  recover(options: HostRecoveryOptions): BudgetResult<{ released: number }> {
    if (!closedRecord(options, ['ownerPrefix', 'tokens', 'acknowledgement']) || !identifier(options.ownerPrefix)
      || !Array.isArray(options.tokens) || options.tokens.length > 1000
      || options.tokens.some(token => !identifier(token)) || new Set(options.tokens).size !== options.tokens.length
      || !closedRecord(options.acknowledgement, ['workStopped', 'evidenceDigest'])
      || options.acknowledgement.workStopped !== true || typeof options.acknowledgement.evidenceDigest !== 'string'
      || !/^[a-fA-F0-9]{64}$/u.test(options.acknowledgement.evidenceDigest)) {
      return { ok: false, reason: 'invalid-input', detail: 'Exact unique tokens and SHA256 evidence of stopped work are required' };
    }
    return this.#flatten(this.#operate(db => {
      for (const token of options.tokens) {
        const row = db.prepare('SELECT owner, provider_key FROM budget_reservations WHERE token = ?').get(token);
        if (!row || typeof row.owner !== 'string' || !row.owner.startsWith(options.ownerPrefix)) {
          throw new Denied('invalid-input', 'Selected token is missing or belongs to another owner');
        }
        this.#provider(db, String(row.provider_key));
      }
      let released = 0;
      const update = db.prepare('UPDATE budget_reservations SET released = 1 WHERE token = ? AND released = 0');
      for (const token of options.tokens) released += Number(update.run(token).changes);
      return { released };
    }));
  }

  /** Closing does not release reservations; an operation may still be running. */
  verifyMigration(snapshot: LegacySnapshot, ownerPrefix: string): BudgetResult<{ matched: boolean; sourceDigest: string }> {
    return this.#flatten(this.#operate(db => {
      const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='budget_legacy_migrations'").get();
      const row = exists ? db.prepare('SELECT source_digest FROM budget_legacy_migrations WHERE migration_key=?').get(legacyKey(snapshot.databasePath, ownerPrefix)) : undefined;
      return { matched: row?.source_digest === snapshot.sourceDigest, sourceDigest: snapshot.sourceDigest };
    }));
  }

  importLegacy(snapshot: LegacySnapshot, ownerPrefix: string): BudgetResult<{ imported: number; sourceDigest: string }> {
    return this.#flatten(this.#operate(db => {
      const key = legacyKey(snapshot.databasePath, ownerPrefix);
      db.exec(LEGACY_MIGRATIONS);
      const prior = db.prepare('SELECT source_digest FROM budget_legacy_migrations WHERE migration_key=?').get(key);
      if (prior?.source_digest === snapshot.sourceDigest) return { imported: 0, sourceDigest: snapshot.sourceDigest };
      for (const provider of snapshot.providers) {
        this.#provider(db, provider.providerKey);
        db.prepare('UPDATE budget_providers SET paused_until=MAX(paused_until,?),last_observed_at=MAX(last_observed_at,?) WHERE provider_key=?')
          .run(provider.pausedUntil, provider.observedAt, provider.providerKey);
        db.prepare(`INSERT INTO budget_pruning_state(provider_key,pruned_through) VALUES (?,?)
          ON CONFLICT(provider_key) DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through)`)
          .run(provider.providerKey, provider.prunedThrough);
      }
      let imported = 0;
      // Provenance must outlive reservation pruning: recovering an imported hold may
      // never be undone by a later source revision whose old row is still active.
      const remember = db.prepare('INSERT INTO budget_legacy_imported_tokens(token) VALUES (?) ON CONFLICT(token) DO NOTHING');
      const insert = db.prepare('INSERT INTO budget_reservations(token,provider_key,owner,admitted_at,released) VALUES (?,?,?,?,?) ON CONFLICT(token) DO NOTHING');
      for (const reservation of snapshot.reservations) {
        const owner = ownerPrefix + reservation.owner;
        if (!identifier(owner)) throw new Denied('invalid-input', 'Prefixed legacy owner exceeds identifier bounds');
        const token = legacyToken(key, reservation.token);
        if (remember.run(token).changes === 0) continue;
        imported += Number(insert.run(token, reservation.providerKey, owner, reservation.admittedAt, reservation.released).changes);
      }
      db.prepare(`INSERT INTO budget_legacy_migrations(migration_key,source_digest,imported_at) VALUES (?,?,?)
        ON CONFLICT(migration_key) DO UPDATE SET source_digest=excluded.source_digest,imported_at=excluded.imported_at`)
        .run(key, snapshot.sourceDigest, Date.now());
      return { imported, sourceDigest: snapshot.sourceDigest };
    }));
  }

  close(): void {
    if (!this.#closed) { this.#closed = true; this.#database?.close(); }
  }

  #provider(db: DatabaseSync, providerKey: string) {
    const limits = this.#providers.get(providerKey);
    if (!limits) throw new Denied('unknown-provider');
    const now = Date.now();
    if (!integer(now)) throw new Denied('invalid-input', 'Invalid system clock');
    // A new row starts unobserved (0): only #observe (reserve, recordQuotaError) stamps the clock,
    // so a status() read under a forward clock cannot create a provider already marked ahead.
    db.exec(CONCURRENCY_MODES);
    const inserted = db.prepare(`INSERT INTO budget_providers
      (provider_key, max_concurrent, max_hour, max_day, cooldown_ms, paused_until, last_observed_at)
      VALUES (?, ?, ?, ?, ?, 0, 0) ON CONFLICT(provider_key) DO NOTHING`)
      .run(providerKey, limits.maxConcurrent, limits.maxLaunchesPerHour, limits.maxLaunchesPerDay, limits.quotaCooldownMs);
    const mode = this.#modes.get(providerKey) ?? 'limited';
    if (inserted.changes === 1) db.prepare('INSERT INTO budget_concurrency_modes(provider_key, mode) VALUES (?, ?)').run(providerKey, mode);
    const persistedMode = db.prepare('SELECT mode FROM budget_concurrency_modes WHERE provider_key = ?').get(providerKey)?.mode ?? 'limited';
    if (persistedMode !== 'limited' && persistedMode !== 'unlimited') throw Error('Invalid stored concurrency mode');
    const row = db.prepare('SELECT * FROM budget_providers WHERE provider_key = ?').get(providerKey) as unknown as ProviderRow;
    const legacyMismatch = !this.#modes.has(providerKey) && (persistedMode !== mode || row.max_concurrent !== limits.maxConcurrent);
    if (legacyMismatch || row.max_hour !== limits.maxLaunchesPerHour
      || row.max_day !== limits.maxLaunchesPerDay || row.cooldown_ms !== limits.quotaCooldownMs) throw new Denied('configuration-mismatch');
    if (persistedMode === 'unlimited' && row.max_concurrent !== 0) throw Error('Invalid stored unlimited policy');
    return { row, limits: {...limits, maxConcurrent:row.max_concurrent}, now, mode:persistedMode };
  }

  /** Only a ledger mutation (reserve, recordQuotaError) advances the observed clock; reads never do. */
  #observe(db: DatabaseSync, row: ProviderRow, now: number): void {
    if (now < row.last_observed_at) throw rollback(row);
    db.prepare('UPDATE budget_providers SET last_observed_at = ? WHERE provider_key = ?').run(now, row.provider_key);
    // Expired, completed records no longer affect a rolling window. Active rows are never pruned.
    db.prepare('DELETE FROM budget_reservations WHERE provider_key = ? AND admitted_at <= ? AND released = 1').run(row.provider_key, now - DAY);
  }

  #status(db: DatabaseSync, row: ProviderRow, limits: LaunchBudgetLimits, now: number): LaunchBudgetStatus {
    const counts = db.prepare(`SELECT COUNT(*) FILTER (WHERE released = 0) AS active,
      COUNT(*) FILTER (WHERE admitted_at > ?) AS hour,
      COUNT(*) FILTER (WHERE admitted_at > ?) AS day FROM budget_reservations WHERE provider_key = ?`)
      .get(now - HOUR, now - DAY, row.provider_key)!;
    const reservations = db.prepare(`SELECT token, provider_key AS providerKey, owner, admitted_at AS admittedAt
      FROM budget_reservations WHERE provider_key = ? AND released = 0 ORDER BY admitted_at, token`).all(row.provider_key) as unknown as LaunchReservation[];
    return { providerKey: row.provider_key, limits: { ...limits }, active: Number(counts.active),
      launchesLastHour: Number(counts.hour), launchesLastDay: Number(counts.day),
      pausedUntil: row.paused_until > now ? row.paused_until : null, reservations };
  }

  #operate<T>(work: (db: DatabaseSync) => T): BudgetResult<{ value: T }> {
    if (this.#closed) return { ok: false, reason: 'closed' };
    if (!this.#database) return { ok: false, reason: 'storage-unavailable', detail: this.#fault ?? 'Database unavailable' };
    try { return { ok: true, value: this.#database.transaction(work) }; }
    catch (error) {
      if (error instanceof Denied) return { ok: false, ...error.failure };
      return { ok: false, reason: 'storage-unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  #flatten<T>(result: BudgetResult<{ value: T }>): BudgetResult<T> {
    return result.ok ? { ok: true, ...result.value } : result;
  }
}
