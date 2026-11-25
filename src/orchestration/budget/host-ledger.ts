import type { ConcurrencyChange } from './host-types.ts';
import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { observedUsageLimitReset } from '../../public/errors.ts';
import { BudgetEngine } from './engine.ts';
import { armBell } from './bell.ts';
import { validateHostOptions } from './host-options.ts';
import { LaunchRefusedError, LaunchReleaseError, LaunchQuotaRecordError } from './host-types.ts';
import { closedRecord, integer } from './validation.ts';
import { readLegacySnapshot, type LegacyMigrationOptions, type LegacyMigrationSource } from './legacy-migration.ts';
import type { BudgetResult, LaunchBudgetLimits } from './types.ts';
import { isLaunchPriority, type LaunchTurn } from './priority.ts';
import type { LaunchPriority } from './host-types.ts';
import type { AcquireOptions, HostLaunchAdmission, HostLaunchBudgetLimits, HostLaunchBudgetStatus, HostLedgerOptions, HostRecoveryOptions, SlotOptions, HostOwnerLookupOptions, HostOwnerLookup, HostLedgerIdentity } from './host-types.ts';
export * from './host-types.ts';
export { HOST_LAUNCH_LIMITS, hostLaunchLimits, hostLedgerPath } from './host-options.ts';
export { inspectLegacyLaunchBudget, type LegacyMigrationOptions, type LegacyMigrationSource } from './legacy-migration.ts';
export { WAITER_LEASE_MS } from './priority.ts';

const BACKSTOP_MS = 30_000;
function snapshotAcquire(options: AcquireOptions | SlotOptions, slot = false): Readonly<SlotOptions> {
  const keys = ['maxWaitMs', 'signal', 'priority', ...(slot ? ['isQuotaError'] : [])];
  if (!closedRecord(options, keys, ['signal', 'priority', 'isQuotaError']) || !integer(options.maxWaitMs)
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || ('isQuotaError' in options && options.isQuotaError !== undefined && typeof options.isQuotaError !== 'function')) {
    throw new TypeError('Wait options require a nonnegative safe integer maxWaitMs and an optional AbortSignal');
  }
  if (options.priority !== undefined && !isLaunchPriority(options.priority)) throw new TypeError('priority must be "normal" or "low"');
  const snapshot: SlotOptions = { maxWaitMs: options.maxWaitMs };
  if (options.priority !== undefined) snapshot.priority = options.priority;
  if (options.signal !== undefined) snapshot.signal = options.signal;
  if ('isQuotaError' in options && options.isQuotaError !== undefined) snapshot.isQuotaError = options.isQuotaError as (error: unknown) => boolean;
  return Object.freeze(snapshot);
}

/** Trusted local coordination for cooperating processes; this is not a vendor quota or authorization boundary. */
export class HostLedger {
  readonly #engine: BudgetEngine;
  readonly #bell: string;
  readonly #databasePath: string;
  readonly #waits = new Set<() => void>();
  /** Waiting callers of this handle whose declaration may be recorded in the shared file. */
  readonly #queued = new Set<string>();
  #closed = false;

  constructor(options: HostLedgerOptions = {}) {
    // Finish every validation before creating even the parent directory.
    const config = validateHostOptions(options);
    this.#databasePath = config.databasePath;
    this.#bell = `${config.databasePath}.bell`;
    const providers: Record<string, LaunchBudgetLimits> = Object.create(null);
    const modes = new Map<string, string>();
    for (const [key, policy] of config.policies) {
      const { concurrency, ...limits } = policy;
      providers[key] = { ...limits, maxConcurrent: concurrency.mode === 'limited' ? concurrency.maxConcurrent : 0 };
      modes.set(key, concurrency.mode);
    }
    mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
    this.#engine = new BudgetEngine({ databasePath: config.databasePath, providers, busyTimeoutMs: config.busyTimeoutMs }, modes);
    try { closeSync(openSync(this.#bell, 'a', 0o600)); } catch { /* Bounded waits remain safe without notification. */ }
  }

  /** One immediate attempt. A `low` priority is refused while a `normal` launch is waiting for the slot. */
  reserve(providerKey: string, owner: string, priority?: LaunchPriority): HostLaunchAdmission {
    return this.#engine.reserve(providerKey, owner, undefined, priority === undefined ? undefined : { priority });
  }
  release(token: string) {
    const result = this.#engine.release(token);
    if (result.ok && result.released) this.#ring();
    return result;
  }
  recordQuotaError(providerKey: string, retryAtMs?: number) {
    const result = this.#engine.recordQuotaError(providerKey, retryAtMs);
    if (result.ok) this.#ring();
    return result;
  }
  status(providerKey: string): BudgetResult<{ status: HostLaunchBudgetStatus }> {
    return this.#engine.hostStatus(providerKey);
  }
  getConcurrency(providerKey: string) { return this.#engine.concurrencyPolicy(providerKey); }
  setConcurrency(providerKey: string, change: ConcurrencyChange) {
    if (change === undefined) throw new TypeError('A concurrency change is required');
    const result = this.#engine.concurrencyPolicy(providerKey,change);
    if (result.ok) this.#ring();
    return result;
  }
  /** Private host evidence discovery, not an authorization or stopped-work proof; default bound detects duplicate owners. */
  lookupOwner(providerKey: string, owner: string, options: HostOwnerLookupOptions = { limit: 2 }): BudgetResult<HostOwnerLookup> {
    return this.#engine.lookupOwner(providerKey, owner, options);
  }
  /** Opaque identity of the actual pinned local database, never worker-supplied authority or stopped-work evidence. */
  storageIdentity(): BudgetResult<{ identity: HostLedgerIdentity }> { return this.#engine.storageIdentity(); }
  recover(options: HostRecoveryOptions) {
    const result = this.#engine.recover(options);
    if (result.ok && result.released > 0) this.#ring();
    return result;
  }

  verifyLegacyMigration(options: LegacyMigrationSource): BudgetResult<{ matched: boolean; sourceDigest: string }> {
    try { return this.#engine.verifyMigration(this.#legacy(options, false), options.ownerPrefix); }
    catch (error) { return { ok: false, reason: error instanceof TypeError ? 'invalid-input' : 'storage-unavailable' }; }
  }

  importLegacy(options: LegacyMigrationOptions): BudgetResult<{ imported: number; sourceDigest: string }> {
    try { return this.#engine.importLegacy(this.#legacy(options, true), options.ownerPrefix); }
    catch (error) { return { ok: false, reason: error instanceof TypeError ? 'invalid-input' : 'storage-unavailable' }; }
  }

  #legacy(options: LegacyMigrationSource | LegacyMigrationOptions, importing: boolean) {
    const keys = ['databasePath', 'ownerPrefix', ...(importing ? ['sourceStoppedConfirmed', 'expectedDigest'] : [])];
    if (!closedRecord(options, keys) || typeof options.ownerPrefix !== 'string' || !options.ownerPrefix.endsWith(':')
      || options.ownerPrefix.length > 128 || options.ownerPrefix.trim() !== options.ownerPrefix
      || /[\x00-\x20\x7f]/.test(options.ownerPrefix)
      || (importing && (!('sourceStoppedConfirmed' in options) || options.sourceStoppedConfirmed !== true
        || !('expectedDigest' in options) || typeof options.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedDigest)))) {
      throw new TypeError('A reviewed legacy source and explicit stopped-source acknowledgement are required');
    }
    const snapshot = readLegacySnapshot(options.databasePath as string), target = lstatSync(this.#databasePath);
    if (snapshot.identity.dev === target.dev && snapshot.identity.ino === target.ino) throw new TypeError('Legacy source and host ledger must differ');
    if (importing && 'expectedDigest' in options && options.expectedDigest !== snapshot.sourceDigest) throw new TypeError('Legacy source changed after inspection');
    return snapshot;
  }
  close(): void {
    this.#closed = true;
    this.#leaveQueue([...this.#queued]);
    this.#engine.close();
    for (const cancel of this.#waits) cancel();
    this.#waits.clear();
  }

  async acquire(providerKey: string, owner: string, options: AcquireOptions): Promise<HostLaunchAdmission> {
    const snapshot = snapshotAcquire(options);
    return this.#acquire(providerKey, owner, snapshot);
  }
  /**
   * Admission in priority order. A caller that waits is declared in the shared file from its first
   * refused attempt until it is admitted or stops waiting, and other handles are woken when it leaves.
   */
  #acquire(providerKey: string, owner: string, options: Readonly<AcquireOptions>): Promise<HostLaunchAdmission> {
    const turn: LaunchTurn = { priority: options.priority ?? 'normal' };
    // An immediate attempt never queues: it settles exactly as it did before priorities existed.
    if (options.maxWaitMs === 0) return this.#attempts(providerKey, owner, options, turn);
    const waiter = randomUUID();
    turn.waiter = waiter;
    return this.#attempts(providerKey, owner, options, turn).finally(() => {
      if (this.#queued.has(waiter)) this.#leaveQueue([waiter]);
    });
  }
  #leaveQueue(waiters: readonly string[]): void {
    for (const waiter of waiters) {
      this.#queued.delete(waiter);
      this.#engine.stopWaiting(waiter);
    }
    // A lower priority may have left a free slot to this waiter: let it look again.
    if (waiters.length > 0) this.#ring();
  }
  async #attempts(providerKey: string, owner: string, options: Readonly<AcquireOptions>, turn: LaunchTurn): Promise<HostLaunchAdmission> {
    const deadline = performance.now() + options.maxWaitMs;
    for (;;) {
      options.signal?.throwIfAborted();
      if (options.maxWaitMs > 0 && performance.now() >= deadline) return { allowed: false, reason: 'wait-timeout' };
      const bell = armBell(this.#bell, options.signal);
      this.#waits.add(bell.cancel);
      let admission: HostLaunchAdmission;
      try {
        // A waiter woken by the bell arms the watch above from inside the poll phase, so the next
        // poll is one loop turn away. Yield that turn first, or a release landing in it is not heard.
        if (options.maxWaitMs > 0) await new Promise<void>((resolve) => { setImmediate(resolve); });
        // A file watch starts listening when the loop next polls, which is before `setImmediate`
        // runs. Attempting sooner would miss a release that lands in this same turn.
        if (options.maxWaitMs > 0) {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          options.signal?.throwIfAborted();
        }
        admission = options.maxWaitMs === 0 ? this.#engine.reserve(providerKey, owner, undefined, turn)
          : this.#engine.reserve(providerKey, owner, () => performance.now() < deadline && !options.signal?.aborted, turn);
        if (!admission.allowed && turn.waiter !== undefined && !this.#closed) this.#queued.add(turn.waiter);
        if (!admission.allowed && 'outranked' in admission && options.maxWaitMs > 0) {
          // The slot belongs to a waiting launch of higher priority: sleep until something changes.
          options.signal?.throwIfAborted();
          const left = deadline - performance.now();
          if (left <= 0) return { allowed: false, reason: 'wait-timeout' };
          await bell.wait(Math.min(left, BACKSTOP_MS));
          continue;
        }
        options.signal?.throwIfAborted();
        if (admission.allowed || options.maxWaitMs === 0 || (admission.reason !== 'concurrency-limit' && admission.reason !== 'quota-cooldown')) return admission;
        const status = this.status(providerKey);
        if (!status.ok) { const { ok: _ok, ...failure } = status; return { allowed: false, ...failure }; }
        const state = status.status, concurrency = state.limits.concurrency;
        if (concurrency.mode === 'limited' && concurrency.maxConcurrent === 0) return admission;
        if (admission.reason === 'concurrency-limit' && (concurrency.mode === 'unlimited' || state.active < concurrency.maxConcurrent)) continue;
        const exhausted = state.launchesLastHour >= state.limits.maxLaunchesPerHour ? 'hourly-limit'
          : state.launchesLastDay >= state.limits.maxLaunchesPerDay ? 'daily-limit' : undefined;
        if (exhausted) return { allowed: false, reason: exhausted };
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { allowed: false, reason: 'wait-timeout' };
        const untilQuota = admission.reason === 'quota-cooldown' && admission.retryAt !== undefined
          ? Math.max(1, admission.retryAt - Date.now()) : BACKSTOP_MS;
        await bell.wait(Math.min(remaining, BACKSTOP_MS, untilQuota));
      } finally { bell.cancel(); this.#waits.delete(bell.cancel); }
    }
  }

  async withSlot<T>(providerKey: string, owner: string, options: SlotOptions, operation: () => Promise<T>): Promise<T> {
    const snapshot = snapshotAcquire(options, true);
    if (typeof operation !== 'function') throw new TypeError('An operation is required');
    const admission = await this.#acquire(providerKey, owner, snapshot);
    if (!admission.allowed) throw new LaunchRefusedError(admission);
    let operationError: unknown;
    let operationStarted = false;
    try {
      // Admission and this continuation are separated by an await. Keep the hold protected
      // while checking whether the caller stopped or closed the ledger in that gap.
      snapshot.signal?.throwIfAborted();
      if (this.#closed) throw new LaunchRefusedError({ allowed: false, reason: 'closed' });
      operationStarted = true;
      return await operation();
    }
    catch (error) {
      operationError = error;
      if (operationStarted && snapshot.isQuotaError?.(error)) {
        const recorded = this.recordQuotaError(providerKey, observedUsageLimitReset(error, providerKey));
        if (!recorded.ok) {
          operationError = new LaunchQuotaRecordError(recorded, error);
          throw operationError;
        }
      }
      throw error;
    } finally {
      const release = this.release(admission.reservation.token);
      if (!release.ok) throw new LaunchReleaseError(release, operationError);
    }
  }
  #ring(): void {
    try { writeFileSync(this.#bell, String(process.hrtime.bigint()), { mode: 0o600 }); } catch { /* Event loss only delays a waiter. */ }
  }
}
