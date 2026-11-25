import type { HostLedger } from '../budget/host-ledger.js';
import { LaunchRefusedError, LaunchReleaseError } from '../budget/host-types.js';
import type { ObservedTaskBudget } from '../tasks/index.js';

/** The part of the shared admission ledger a canary needs. */
export type CanaryLedger = Pick<HostLedger, 'acquire' | 'release'>;

export interface CanaryBudgetOptions {
  /** The provider account whose slots the evaluated system uses. */
  providerKey: string;
  /** Shown as the holder of the slot, for example `my-system:canary`. */
  owner: string;
  /** How long one attempt may wait for a slot. It counts against the attempt's own timeout. */
  maxWaitMs: number;
}

/**
 * Admission for evaluation attempts at the ledger's lowest priority. Each attempt takes one slot
 * and gives it back when it settles; while a production launch is waiting, the attempt waits behind
 * it. A refused admission rejects with `LaunchRefusedError`, which the evaluation runner records as
 * a budget denial. The evaluated `run` must not take a second slot for the same turn.
 */
export function canaryBudget(ledger: CanaryLedger, options: CanaryBudgetOptions): ObservedTaskBudget {
  if (ledger === null || typeof ledger !== 'object' || typeof ledger.acquire !== 'function' || typeof ledger.release !== 'function') {
    throw new TypeError('A ledger with acquire and release is required');
  }
  const keys = options !== null && typeof options === 'object' ? Object.keys(options).sort().join(',') : '';
  if (keys !== 'maxWaitMs,owner,providerKey'
    || typeof options.providerKey !== 'string' || options.providerKey.trim() === ''
    || typeof options.owner !== 'string' || options.owner.trim() === ''
    || !Number.isSafeInteger(options.maxWaitMs) || options.maxWaitMs < 0) {
    throw new TypeError('canaryBudget needs exactly providerKey, owner and a nonnegative integer maxWaitMs');
  }
  const { providerKey, owner, maxWaitMs } = options;
  return {
    async acquire(signal) {
      const admission = await ledger.acquire(providerKey, owner, { maxWaitMs, signal, priority: 'low' });
      if (!admission.allowed) throw new LaunchRefusedError(admission);
      const token = admission.reservation.token;
      return {
        release() {
          const released = ledger.release(token);
          if (!released.ok) throw new LaunchReleaseError(released);
        },
      };
    },
  };
}
