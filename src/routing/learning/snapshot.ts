import type { OperationScope } from '../../control/operation-scope.js';
import { canonical } from '../../shared/json.js';
import { buildSnapshot } from './estimator.js';
import { policyBinding } from './factory-binding.js';
import { assertActive, safeCode, type CapturedSelection } from './factory-context.js';
import type { RouterState } from './router-state.js';
import { validateLearningRecord } from './validation.js';
import type { LearningPreflight, LearningSnapshot } from './types.js';
/** A scoped immutable shadow is evidence only; it never updates the active pointer. */
export async function saveShadow(state: RouterState, captured: CapturedSelection, preflight: LearningPreflight, scope?: OperationScope): Promise<LearningSnapshot> {
    const through = await state.store.highWater(state.domain);
    if (scope)
        assertActive(scope);
    const keys = preflight.actions.map(a => a.key);
    const rows = await state.store.observations(state.domain, { through, split: 'train', verifiedOnly: true,
        schema: captured.features.schema, dimensions: captured.features.values.length, actionKeys: keys, limit: state.policy.maxRows });
    if (scope)
        assertActive(scope);
    // The SQL contract bounds and filters before LIMIT. Defend custom stores too.
    const relevant = rows.filter(r => r.observation.features.schema === captured.features.schema && r.observation.features.values.length === captured.features.values.length && keys.includes(r.observation.action.key));
    const snapshot = buildSnapshot(state.domain, state.policy, through, relevant, Date.now(), policyBinding(captured, preflight));
    const exact = (value: unknown) => {
        const verified = validateLearningRecord('snapshot', value);
        if (canonical(verified) !== canonical(snapshot))
            throw new TypeError('Shadow snapshot binding mismatch');
        return verified;
    };
    const existing = await state.store.get('snapshot', snapshot.digest);
    if (existing) {
        const value = exact(existing);
        if (scope)
            assertActive(scope);
        return value;
    }
    try {
        await state.store.put('snapshot', snapshot.digest, snapshot);
    }
    catch (error) {
        // Only a declared immutable-ID collision permits idempotent reread. Raw IO stays fatal.
        if (safeCode(error) !== 'LEARNING_RECORD_EXISTS')
            throw error;
        const raced = await state.store.get('snapshot', snapshot.digest);
        if (!raced)
            throw error;
        const value = exact(raced);
        if (scope)
            assertActive(scope);
        return value;
    }
    if (scope)
        assertActive(scope);
    return snapshot;
}
