export type { LaunchBudgetLimits, SharedLaunchBudgetOptions, BudgetDenialReason, BudgetFailure,
  LaunchReservation, LaunchAdmission, BudgetResult, LaunchBudgetStatus, ClockAcknowledgement } from './types.ts';
import { BudgetEngine } from './engine.ts';
import type { SharedLaunchBudgetOptions, ClockAcknowledgement } from './types.ts';

/** Finite launch fuse shared by cooperating processes. Active holds never expire or refund launches. */
export class SharedLaunchBudget {
  readonly #engine: BudgetEngine;
  constructor(options: SharedLaunchBudgetOptions) { this.#engine = new BudgetEngine(options); }
  reserve(providerKey: string, owner: string) { return this.#engine.reserve(providerKey, owner); }
  release(token: string) { return this.#engine.release(token); }
  recordQuotaError(providerKey: string) { return this.#engine.recordQuotaError(providerKey); }
  status(providerKey: string) { return this.#engine.status(providerKey); }
  /** Explicit operator clock recovery never refunds holds/history or reopens pruned windows. */
  acknowledgeClock(providerKey: string, acknowledgement: ClockAcknowledgement) {
    return this.#engine.acknowledgeClock(providerKey, acknowledgement);
  }
  close(): void { this.#engine.close(); }
}
