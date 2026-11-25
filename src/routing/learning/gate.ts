import { digest, identifier, ownObject } from '../../shared/json.js';
import { safeCode } from './factory-context.js';
import { assessGateEvidence } from './evidence.js';
import type { RouterState } from './router-state.js';
import { validateLearningRecord } from './validation.js';
import type { LearningGate, LearningGateCommit, LearningGateOptions, LearningSnapshot, PolicyRef } from './types.js';
/** Only transactional evidence replay in the store changes active pointers. */
export async function improvePolicy(state: RouterState, options: LearningGateOptions): Promise<LearningGateCommit> {
    options = ownObject(options, ['id', 'freshEpisodeId']);
    const { id, freshEpisodeId } = options;
    identifier(id);
    identifier(freshEpisodeId);
    const previousGate = await state.store.get('gate', id);
    const previousCommit = previousGate ? await state.store.get('gate-commit', id) : undefined;
    const rawFresh = await state.store.get('episode', freshEpisodeId);
    if (!rawFresh)
        throw new Error('Fresh learning episode is missing');
    const fresh = validateLearningRecord('episode', rawFresh);
    if (fresh.domain !== state.domain || fresh.kind !== 'fresh' || !fresh.comparison || fresh.protocolDigest !== state.protocolDigest
        || digest(fresh.comparison.config) !== digest(state.policy) || fresh.comparison.configDigest !== digest(state.policy))
        throw new TypeError('Invalid fresh episode protocol or configuration scope');
    const rawFixed = await state.store.get('episode', fresh.comparison.fixedEpisodeId);
    if (!rawFixed)
        throw new Error('Fixed learning episode is missing');
    const fixed = validateLearningRecord('episode', rawFixed);
    if (fixed.domain !== state.domain || fixed.kind !== 'fixed' || fixed.protocolDigest !== state.protocolDigest)
        throw new TypeError('Invalid fixed episode protocol scope');
    const replay = (rawGate: LearningGate, rawCommit: LearningGateCommit | undefined): LearningGateCommit => {
        const gate = validateLearningRecord('gate', rawGate);
        if (!rawCommit)
            throw new Error('Stored gate commit is missing');
        const commit = validateLearningRecord('gate-commit', rawCommit);
        if (gate.id !== id || gate.domain !== state.domain || gate.fresh.episodeId !== freshEpisodeId || gate.fresh.episodeDigest !== fresh.digest
            || gate.fixed.episodeDigest !== fixed.digest || gate.definitionDigest !== fresh.definitionDigest
            || gate.expectedGeneration !== fresh.comparison!.expectedGeneration || gate.from !== fresh.comparison!.from || gate.to !== fresh.comparison!.to || gate.mode !== fresh.comparison!.operation || gate.configDigest !== digest(state.policy) || commit.id !== id || commit.domain !== state.domain || commit.gateDigest !== gate.digest)
            throw new TypeError('Immutable gate replay binding mismatch');
        return commit;
    };
    if (previousGate) return replay(previousGate, previousCommit);
    const loadSnapshot = async (ref: PolicyRef): Promise<LearningSnapshot | undefined> => {
        if (ref === null)
            return undefined;
        const row = await state.store.get('snapshot', ref);
        if (!row)
            throw new Error('Comparison snapshot is missing');
        const snapshot = validateLearningRecord('snapshot', row);
        if (snapshot.domain !== state.domain || snapshot.digest !== ref || digest(snapshot.config) !== digest(state.policy))
            throw new TypeError('Comparison snapshot binding or config mismatch');
        return snapshot;
    };
    const fromSnapshot = await loadSnapshot(fresh.comparison.from), toSnapshot = await loadSnapshot(fresh.comparison.to);
    const observationIds = [...new Set([...fixed.cells, ...fresh.cells].map(c => c.observationId))];
    const observations = await state.store.observations(state.domain, { observationIds });
    const gate = assessGateEvidence({ id, createdAt: Date.now(), domain: state.domain, fresh, fixed,
        ...(fromSnapshot === undefined ? {} : { fromSnapshot }), ...(toSnapshot === undefined ? {} : { toSnapshot }), observations });
    try { return await state.store.commitGate(gate); }
    catch (error) {
        if (safeCode(error) !== 'LEARNING_GATE_EXISTS') throw error;
        // Another caller committed this ID after our initial lookup. The first immutable pair wins.
        const committedGate = await state.store.get('gate', id);
        if (!committedGate) throw error;
        const committedReceipt = await state.store.get('gate-commit', id);
        return replay(committedGate, committedReceipt);
    }
}
