import type { BudgetFailure, LaunchAdmission, LaunchBudgetLimits, LaunchBudgetStatus, LaunchReservation } from './types.ts';

export type HostConcurrency = { mode: 'limited'; maxConcurrent: number } | { mode: 'unlimited' };
export interface ConcurrencyPolicy { revision: number; concurrency: HostConcurrency }
export interface ConcurrencyChange { expectedRevision: number; concurrency: HostConcurrency }
export type HostLaunchBudgetLimits = Omit<LaunchBudgetLimits, 'maxConcurrent'> & { concurrency: HostConcurrency };
export type HostLaunchBudgetStatus = Omit<LaunchBudgetStatus, 'limits'> & { limits: HostLaunchBudgetLimits };
export interface HostLedgerOptions {
  databasePath?: string;
  concurrency?: HostConcurrency;
  providers?: Readonly<Record<string, HostLaunchBudgetLimits>>;
  busyTimeoutMs?: number;
}
export type HostLaunchAdmission = LaunchAdmission | { allowed: false; reason: 'wait-timeout' };
export type HostLaunchDenial = Extract<HostLaunchAdmission, { allowed: false }>;
/** `low` is for canaries and evaluation runs: it never takes a slot a waiting `normal` launch is entitled to. */
export type LaunchPriority = 'normal' | 'low';
export interface AcquireOptions { maxWaitMs: number; signal?: AbortSignal; priority?: LaunchPriority }
export interface SlotOptions extends AcquireOptions { isQuotaError?: (error: unknown) => boolean }
/** Trusted host inspection only. Tokens must never cross the worker/model boundary. */
export type HostOwnerReservation = Readonly<LaunchReservation & { released: boolean }>;
export interface HostOwnerLookupOptions { limit: number }
export interface HostOwnerLookup {
  reservations: readonly HostOwnerReservation[];
  truncated: boolean;
}
/** Measured local storage binding only; neither a lease nor permission to release work. */
export interface HostLedgerIdentity { readonly format: 1; readonly digest: string }
export interface HostRecoveryOptions {
  ownerPrefix: string;
  /** Exact previously inspected bearer tokens; never infer these from a prefix at recovery time. */
  tokens: readonly string[];
  acknowledgement: { workStopped: true; evidenceDigest: string };
}
export class LaunchRefusedError extends Error {
  readonly admission: HostLaunchDenial;
  constructor(admission: HostLaunchDenial) {
    super(`Launch refused: ${admission.reason}`); this.name = 'LaunchRefusedError'; this.admission = admission;
  }
}
/** A failed durable release is a halt condition, including when the operation also failed. */
export class LaunchReleaseError extends Error {
  readonly failure: BudgetFailure;
  constructor(failure: BudgetFailure, cause?: unknown) {
    super(`Launch release failed: ${failure.reason}`, { cause }); this.name = 'LaunchReleaseError'; this.failure = failure;
  }
}

/** The observed provider quota error could not be durably recorded; callers must halt admission. */
export class LaunchQuotaRecordError extends Error {
  readonly failure: BudgetFailure;
  constructor(failure: BudgetFailure, cause?: unknown) {
    super(`Launch quota recording failed: ${failure.reason}`, { cause }); this.name = 'LaunchQuotaRecordError'; this.failure = failure;
  }
}
