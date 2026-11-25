import { rethrowExecutionHalt } from '../../public/execution-halt.js';
import type { Agent } from '../../public/agent.js';
import type { OperationScope } from '../../control/operation-scope.js';
import { digest } from '../../shared/json.js';
import { predict, selectPolicyDecision } from './estimator.js';
import { safeCode, type CapturedSelection } from './factory-context.js';
import { appliesTo, policyBinding } from './factory-binding.js';
import { modelMatches, prepareSelection, type PreparedSelection } from './factory.js';
import { scopedPointer, type RouterState } from './router-state.js';
import { sealLearningRecord, validateLearningRecord } from './validation.js';
import type { LearningDecision, LearningSnapshot } from './types.js';
const selectionErrors = new WeakSet<object>();

/** Explains a selection failure without exposing native provider diagnostics. */
export class LearningSelectionError extends Error {
    static [Symbol.hasInstance](value: unknown): boolean {
        return typeof value === 'object' && value !== null && selectionErrors.has(value)
            && Function.prototype[Symbol.hasInstance].call(this, value);
    }
    constructor(readonly code: 'NO_ROUTE' | 'ABORTED' | 'TIMEOUT', readonly receipt: LearningDecision) {
        super(`Learning selection ${code}`);
        this.name = 'LearningSelectionError';
        selectionErrors.add(this);
    }
}
export interface PreparedDecision {
    agent: Agent;
    receipt: LearningDecision;
    prepared: PreparedSelection;
}
export async function decide(state: RouterState, captured: CapturedSelection, scope: OperationScope): Promise<PreparedDecision> {
    let prepared: PreparedSelection | undefined;
    let active: LearningSnapshot | undefined;
    let failure: 'ABORTED' | 'TIMEOUT' | undefined;
    const cancellation = (): 'ABORTED' | 'TIMEOUT' | undefined => scope.signal.aborted || scope.remainingMs() < 1
        ? safeCode(scope.signal.reason) === 'TIMEOUT' || scope.remainingMs() < 1 ? 'TIMEOUT' : 'ABORTED' : undefined;
    try {
        prepared = await prepareSelection(captured, state.domain, scope);
    }
    catch (error) {
        rethrowExecutionHalt(error);
        failure = cancellation();
        if (!failure)
            throw error;
    }
    failure ??= cancellation();
    if (!failure && captured.mode === 'auto' && captured.evaluationArmId === undefined) {
        // Await store IO outside cancellation normalization: raw failures always win.
        const pointer = scopedPointer(await state.store.pointer(state.domain));
        failure = cancellation();
        if (!failure && pointer.active !== null) {
            const value = await state.store.get('snapshot', pointer.active);
            if (!value)
                throw new Error('Active learning snapshot is missing');
            active = validateLearningRecord('snapshot', value);
            if (active.domain !== state.domain || active.digest !== pointer.active)
                throw new TypeError('Active snapshot binding mismatch');
            if (digest(active.config) !== digest(state.policy))
                throw new TypeError('Active policy configuration differs from the declared router config');
            if (!appliesTo(active.binding, policyBinding(captured, prepared!.preflight)))
                active = undefined;
            failure = cancellation();
        }
    }
    const preflight = prepared?.preflight;
    const actions = preflight?.actions ?? [];
    const asOf = Date.now();
    const policyDecision = !failure && captured.evaluationArmId === undefined
        ? selectPolicyDecision(active, actions, captured.features, asOf, captured.fallbackId) : undefined;
    const selected = failure ? undefined : captured.evaluationArmId === undefined
        ? policyDecision?.action : actions.find(a => a.id === captured.evaluationArmId);
    const predictions = active && !failure ? predict(active, captured.features, actions, asOf) : [];
    const supported = policyDecision?.reason === 'supported';
    const reason: LearningDecision['reason'] = failure ?? (!selected ? 'NO_ROUTE' : captured.evaluationArmId !== undefined ? 'MATRIX' : captured.mode === 'fixed' ? 'FIXED'
        : selected.id === captured.fallbackId ? 'FALLBACK' : supported ? 'LEARNED' : 'INCUMBENT');
    const candidates = preflight?.candidates ?? captured.arms.map(a => ({ id: a.id, model: `${a.model.provider}/${a.model.id}`, provider: a.model.provider, modelId: a.model.id, status: 'excluded' as const, code: failure ?? 'PROBE_FAILED' as const }));
    const receipt = sealLearningRecord('decision', { format: 1, id: captured.id, domain: state.domain, createdAt: asOf, taskDigest: captured.taskDigest,
        featuresDigest: digest(captured.features), definitionDigest: captured.definitionDigest, policy: active?.digest ?? null,
        mode: captured.evaluationArmId !== undefined ? 'matrix' : captured.mode, reason, candidates, predictions,
        ...(selected === undefined ? {} : { selected }), nativeDispatches: 0 });
    // Immutable persistence is awaited raw. Cancellation never masks a storage failure.
    await state.store.put('decision', receipt.id, receipt);
    const cancelledAfterSave = cancellation();
    if (cancelledAfterSave)
        throw new LearningSelectionError(cancelledAfterSave, receipt);
    const agent = selected && prepared?.agents.get(selected.key);
    if (!selected || !agent)
        throw new LearningSelectionError(failure ?? 'NO_ROUTE', receipt);
    const expected = captured.arms.find(a => a.id === selected.id)!;
    if (!modelMatches(agent.model, expected.model))
        throw new LearningSelectionError('NO_ROUTE', receipt);
    return { agent, receipt, prepared: prepared! };
}
