import type { OperationScope } from './operation-scope.js';
import { rethrowExecutionHalt } from '../public/execution-halt.js';

export function validateSettlementOption(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError('awaitSettlement must be a boolean');
}

/** Bounded by a dying CLI's SIGTERM-to-SIGKILL window; work outliving it is left to the caller to judge. */
export async function awaitExecWork(work: ReadonlySet<Promise<unknown>>, graceMs = 1000): Promise<void> {
  if (work.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled([...work]), new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Cleanup observes both pending next() and return(); either may outlive the deadline. */
export async function settleExecScope(
  scope: OperationScope, awaitSettlement: boolean | undefined,
  iterator?: AsyncIterator<unknown>, exhausted = false,
  track?: (work: Promise<unknown>) => void,
): Promise<void> {
  if (!exhausted) scope.cancel();
  let cleanupFailure: { error: unknown } | undefined;
  const returning = !exhausted && iterator?.return
    ? Promise.resolve().then(() => iterator.return!()).then(() => undefined, error => { cleanupFailure = { error }; })
    : Promise.resolve();
  track?.(scope.drain().then(() => returning));
  try {
    if (awaitSettlement) {
      await scope.drain(); await returning;
      if (cleanupFailure !== undefined) rethrowExecutionHalt(cleanupFailure.error);
    }
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([returning, new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.min(1000, Math.max(1, scope.remainingMs())));
      })]); } finally { if (timer) clearTimeout(timer); }
    }
  } finally { scope.dispose(); }
}
