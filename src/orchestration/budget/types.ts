/** Local launch ceilings chosen by the operator, not a provider's remaining quota. */
export interface LaunchBudgetLimits {
  maxConcurrent: number;
  maxLaunchesPerHour: number;
  maxLaunchesPerDay: number;
  quotaCooldownMs: number;
}

export interface SharedLaunchBudgetOptions {
  /** All cooperating applications must use the same absolute, local SQLite file. */
  databasePath: string;
  /** Explicit keys must identify both provider and account/quota owner. No defaults. */
  providers: Readonly<Record<string, LaunchBudgetLimits>>;
  /** Maximum synchronous SQLite lock wait. Default 1000 ms; zero fails immediately. */
  busyTimeoutMs?: number;
}

export type BudgetDenialReason = 'unknown-provider' | 'configuration-mismatch' | 'invalid-input'
  | 'storage-unavailable' | 'closed' | 'clock-rollback' | 'concurrency-limit'
  | 'hourly-limit' | 'daily-limit' | 'quota-cooldown';

export interface BudgetFailure {
  reason: BudgetDenialReason;
  detail?: string;
  /** Epoch milliseconds. `quota-cooldown`: when the pause ends. `clock-rollback`: the ledger's last
   *  observed time; admission resumes once the system clock reaches it or `acknowledgeClock` runs.
   *  A refused acknowledgement instead returns when potentially pruned history expires; retrying
   *  acknowledgement then is safe, but ordinary admission still respects the observed clock. */
  retryAt?: number;
  /** With `concurrency-limit`: a slot was free, but a waiting launch of higher priority is entitled to it. */
  outranked?: true;
}

/** An operator verified the system clock and accepts that nothing is refunded (see `acknowledgeClock`). */
export interface ClockAcknowledgement { operatorConfirmed: true }

export interface LaunchReservation {
  /** Bearer token: only release once the operation has actually stopped. */
  token: string;
  providerKey: string;
  owner: string;
  admittedAt: number;
}

export type LaunchAdmission = { allowed: true; reservation: LaunchReservation }
  | ({ allowed: false } & BudgetFailure);

export type BudgetResult<T> = ({ ok: true } & T) | ({ ok: false } & BudgetFailure);

export interface LaunchBudgetStatus {
  providerKey: string;
  limits: LaunchBudgetLimits;
  active: number;
  launchesLastHour: number;
  launchesLastDay: number;
  pausedUntil: number | null;
  /** Includes crashed owners. Verify they stopped before explicitly recovering a token. */
  reservations: LaunchReservation[];
}
