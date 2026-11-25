import { OperationScope } from '../../control/operation-scope.js';
import { AbortError } from '../../public/errors.js';
import { assertActive } from './factory-context.js';
import type { CapturedRun } from './run-context.js';
import type { LearningRunResult } from './types.js';

export function assertCallerActive(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new AbortError({ retryable: true }, 'Learning operation aborted');
}

/** Completed production releases its deadline; trusted maintenance gets its own bounded lifetime. */
export async function runMaintenance(captured: CapturedRun): Promise<LearningRunResult['maintenance']> {
    if (!captured.maintenance) return { status: 'not-requested' };
    const scope = new OperationScope({ timeoutMs: captured.maintenanceTimeoutMs,
        ...(captured.selection.signal === undefined ? {} : { signal: captured.selection.signal }) });
    let failed = false;
    try {
        try {
            assertActive(scope);
            // Await the real hook and cleanup even after its derived signal aborts.
            await captured.maintenance({ signal: scope.signal });
        }
        catch { failed = true; }
        // Caller cancellation remains a rejection, independently of a maintenance timeout/failure.
        assertCallerActive(captured.selection.signal);
        if (scope.signal.aborted || scope.remainingMs() < 1)
            return { status: 'failed', code: 'MAINTENANCE_TIMEOUT' };
        return failed ? { status: 'failed', code: 'MAINTENANCE_FAILED' } : { status: 'completed' };
    }
    finally { scope.dispose(); }
}
