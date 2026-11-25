import { describe, expect, it } from 'vitest';
import { digest } from '../../src/routing/json.js';
import { hashTaskFeatures } from '../../src/routing/learning/features.js';
import { DEFAULT_LEARNING_POLICY, buildSnapshot, predict, selectPolicy } from '../../src/routing/learning/estimator.js';
import { sealLearningRecord, validateLearningRecord } from '../../src/routing/learning/validation.js';
import type { LearningAction, LearningObservation } from '../../src/routing/learning/types.js';
const domain = digest('domain');
const action = (id: string): LearningAction => { const b = { model: id, evidenceScope: 'model' as const, provider: 'p', modelId: id, optionsDigest: digest({}), executionDigest: digest('cli') }; return { id, ...b, key: digest(b) }; };
const a = action('a'), b = action('b');
const feature = (n: number) => ({ schema: 'local-v1', values: n === 0 ? [1, 0] : [0, 1] });
function row(sequence: number, act: LearningAction, task: string, context: number, q: number, age = 1000) {
    const o = sealLearningRecord('observation', { format: 1, id: `o${sequence}`, domain, attemptId: `a${sequence}`, decisionId: `d${sequence}`, decisionDigest: digest('d'), action: act, taskDigest: digest(task), features: feature(context), split: 'train', outcome: 'completed', quality: { state: 'verified', value: q, passed: q > .5 }, latency: { state: 'observed', durationMs: 100 }, createdAt: age });
    return { sequence, observation: o };
}
describe('contextual frozen estimator', () => {
    it('learns different preferred actions in two contexts using distinct verified inputs', () => {
        const rows = [];
        let seq = 0;
        for (let i = 0; i < 12; i++)
            for (const act of [a, b])
                for (const c of [0, 1])
                    rows.push(row(++seq, act, `task${i}-${c}`, c, act.id === (c === 0 ? 'a' : 'b') ? 1 : .1));
        const s = buildSnapshot(domain, DEFAULT_LEARNING_POLICY, seq, rows, 1000);
        expect(selectPolicy(s, [a, b], feature(0), 1000)?.id).toBe('a');
        expect(selectPolicy(s, [a, b], feature(1), 1000)?.id).toBe('b');
        expect(Object.isFrozen(s.rows)).toBe(true);
        expect(validateLearningRecord('snapshot', s).digest).toBe(s.digest);
    });
    it('repetitions cannot inflate support, stale/unknown costs cannot rank', () => {
        const s = buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 20, Array.from({ length: 20 }, (_, i) => row(i + 1, b, 'same', 0, 1)), 1000);
        expect(predict(s, feature(0), [b], 1000)[0]?.support).toBe(1);
        expect(selectPolicy(s, [a, b], feature(0), 1000)?.id).toBe('a');
        expect(predict(s, feature(0), [b], DEFAULT_LEARNING_POLICY.maxAgeMs + 1001)[0]?.reason).toBe('stale');
        const costs = buildSnapshot(domain, { ...DEFAULT_LEARNING_POLICY, objective: 'cost' }, 3, [row(1, b, '1', 0, 1), row(2, b, '2', 0, 1), row(3, b, '3', 0, 1)], 1000);
        expect(predict(costs, feature(0), [b], 1000)[0]?.costUsd).toBeUndefined();
    });
    it('rejects nontraining, future, mixed-schema and unverified rows', () => {
        const good = row(1, a, 't', 0, 1);
        const body = { ...good.observation, split: 'fixed' } as LearningObservation;
        expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 1, [{ sequence: 1, observation: sealLearningRecord('observation', (({ digest: _, ...v }) => v)(body)) }], 1000)).toThrow();
        expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 0, [good], 1000)).toThrow();
    });
    it('binds complete action and feature scope while leaving standalone unbound estimates usable', () => {
        const rows = [row(1, a, 'a', 0, 1), row(2, b, 'b', 0, 1)], binding = { definitionDigest: digest('definition'), actions: [a, b], features: { schema: 'local-v1', dimensions: 2 } };
        expect(buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 2, rows, 1000, binding).binding).toEqual(binding);
        expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 2, rows, 1000, { ...binding, actions: [a] })).toThrow(/scope/);
        expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 2, rows, 1000, { ...binding, features: { schema: 'local-v1', dimensions: 3 } })).toThrow(/scope/);
    });
});
