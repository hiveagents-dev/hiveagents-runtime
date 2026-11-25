import { describe, expect, it, vi } from 'vitest';
import { digest } from '../../src/routing/json.js';
import { assessGateEvidence } from '../../src/routing/learning/evidence.js';
import { buildSnapshot, DEFAULT_LEARNING_POLICY } from '../../src/routing/learning/estimator.js';
import { sealLearningRecord } from '../../src/routing/learning/validation.js';
import type { LearningAction, LearningEpisode, SequencedObservation } from '../../src/routing/learning/types.js';
const body = <T extends {
    digest: string;
}>(v: T): Omit<T, 'digest'> => { const { digest: _, ...b } = v; return b; };
const domain = digest('domain'), features = { schema: 'unit', values: [1, 0] }, config = { ...DEFAULT_LEARNING_POLICY, minDistinctTasks: 3 };
function action(id: string): LearningAction { const b = { model: id, evidenceScope: 'model' as const, provider: 'p', modelId: id, optionsDigest: digest({}), executionDigest: digest('cli') }; return { id, ...b, key: digest(b) }; }
const arms = [action('a'), action('b')];
function obs(id: string, task: string, a: LearningAction, q: number, split: 'train' | 'fixed' | 'fresh', sequence: number, episodeId?: string): SequencedObservation { return { sequence, observation: sealLearningRecord('observation', { format: 1, id, domain, attemptId: `a${id}`, decisionId: `d${id}`, decisionDigest: digest(id), action: a, taskDigest: digest(task), features, split, ...(episodeId ? { episodeId, repetition: 0 } : {}), outcome: 'completed', quality: { state: 'verified', value: q, passed: true }, latency: { state: 'observed', durationMs: 10 }, createdAt: split === 'fresh' ? 40 : 10 }) }; }
function fixture(regression = false) {
    let seq = 0;
    const training: SequencedObservation[] = [];
    for (let i = 0; i < 12; i++)
        for (const a of arms)
            training.push(obs(`train${++seq}`, `train${i}`, a, a.id === 'b' ? 1 : .5, 'train', seq));
    const snapshot = buildSnapshot(domain, config, seq, training, 20, { definitionDigest: digest('def'), actions: arms, features: { schema: 'unit', dimensions: 2 } });
    const rows: SequencedObservation[] = [];
    const episode = (kind: 'fixed' | 'fresh', count: number): LearningEpisode => {
        const id = kind;
        const tasks = Array.from({ length: count }, (_, i) => ({ taskDigest: digest(`${kind}${i}`), features }));
        const cells = [];
        for (let i = 0; i < count; i++)
            for (const a of arms) {
                const id = `${kind}${i}${a.id}`;
                const row = obs(id, `${kind}${i}`, a, a.id === 'b' ? (regression && i === 0 ? .2 : 1) : .5, kind, ++seq, kind);
                rows.push(row);
                cells.push({ taskDigest: row.observation.taskDigest, actionKey: a.key, repetition: 0, attemptId: row.observation.attemptId, observationId: id });
            }
        return sealLearningRecord('episode', { format: 1, id, domain, kind, createdAt: kind === 'fixed' ? 1 : 30, definitionDigest: digest('def'), protocolDigest: digest('protocol'), afterSequence: 24, arms, tasks, repetitions: 1, cells, ...(kind === 'fresh' ? { comparison: { expectedGeneration: 0, from: null, to: snapshot.digest, operation: 'promote' as const, fixedEpisodeId: 'fixed', config, configDigest: digest(config) } } : {}) });
    };
    const fixed = episode('fixed', 2), fresh = episode('fresh', 6);
    return { id: 'gate', createdAt: 50, domain, fresh, fixed, toSnapshot: snapshot, observations: rows };
}
describe('single pure paired gate evaluator', () => {
    it('promotes distinct paired evidence, fixed may predate frozen snapshot', () => { const g = assessGateEvidence(fixture()); expect(g.outcome).toBe('promote'); expect(g.fresh.wins).toBe(6); expect(g.fresh.pValue).toBeCloseTo(1 / 64); expect(g.fixed.wins).toBe(2); });
    it('keeps incomplete and any quality regression and prevents fresh cutoff leakage', () => { const f = fixture(); expect(assessGateEvidence({ ...f, observations: f.observations.slice(1) }).reason).toBe('INCOMPLETE'); expect(assessGateEvidence(fixture(true)).reason).toBe('REGRESSION'); const bad = sealLearningRecord('episode', { ...body(f.fresh), afterSequence: 0 }); expect(assessGateEvidence({ ...f, fresh: bad }).reason).toBe('INCOMPARABLE'); });
    it('never counts repeated cells as independent support and compares no fabricated cost', () => { const f = fixture(); const config = { ...DEFAULT_LEARNING_POLICY, objective: 'cost' as const }; const snapshot = buildSnapshot(domain, config, 24, f.toSnapshot.rows, 20, f.toSnapshot.binding); const fresh = sealLearningRecord('episode', { ...body(f.fresh), comparison: { ...f.fresh.comparison!, to: snapshot.digest, config, configDigest: digest(config) } }); expect(assessGateEvidence({ ...f, fresh, toSnapshot: snapshot }).outcome).toBe('keep'); });
    it.each([{ schema: 'unit', values: [1, 0, 0] }, { schema: 'different', values: [1, 0] }])('refuses fixed/fresh/snapshot feature identity mismatch %#', (features) => {
        const f = fixture();
        const fixed = sealLearningRecord('episode', { ...body(f.fixed), tasks: f.fixed.tasks.map(t => ({ ...t, features })) });
        const observations = f.observations.map(r => r.observation.split === 'fixed' ? { ...r, observation: sealLearningRecord('observation', { ...body(r.observation), features, quality: { state: 'verified', value: r.observation.action.id === 'a' ? 1 : 0, passed: true } }) } : r);
        expect(assessGateEvidence({ ...f, fixed, observations }).reason).toBe('INCOMPARABLE');
        expect(() => sealLearningRecord('episode', { ...body(f.fixed), tasks: [{ ...f.fixed.tasks[0]!, features }, f.fixed.tasks[1]!] })).toThrow(/feature|schema|dimension/i);
    });
    it('binds every terminal cell, including unknown quality and censored failure evidence', () => {
        const f = fixture(), row = f.observations.find(r => r.observation.split === 'fresh')!;
        const failed = sealLearningRecord('observation', { ...body(row.observation), outcome: 'verifier-error', quality: { state: 'unknown', reason: 'oracle-failed' }, latency: { state: 'right-censored', durationMs: 100 } });
        const actual = assessGateEvidence({ ...f, observations: f.observations.map(r => r === row ? { ...r, observation: failed } : r) }), pending = assessGateEvidence({ ...f, observations: f.observations.filter(r => r !== row) });
        expect(actual.reason).toBe('INCOMPLETE');
        expect(actual.fresh.observationDigests).toContain(failed.digest);
        expect(actual.fresh.verifiedCells).toBe(11);
        expect(actual.digest).not.toBe(pending.digest);
    });
    it('rejects causal timestamp inversions without changing the frozen replay clock', () => {
        const f = fixture();
        expect(() => assessGateEvidence({ ...f, createdAt: 0 })).toThrow(/time|date|causal/i);
        const observations = f.observations.map(r => r.observation.split === 'fresh' ? { ...r, observation: sealLearningRecord('observation', { ...body(r.observation), createdAt: 29 }) } : r);
        expect(assessGateEvidence({ ...f, observations }).reason).toBe('INCOMPARABLE');
    });
    it('reuses validated immutable snapshots instead of traversing 128d training rows for each policy lookup', () => {
        const f = fixture(), spy = vi.spyOn(Object, 'getOwnPropertyDescriptors');
        try {
            assessGateEvidence(f);
            const large = spy.mock.calls.filter(([x]) => x && typeof x === 'object' && 'rows' in x);
            expect(large.length).toBeLessThanOrEqual(2);
        }
        finally {
            spy.mockRestore();
        }
    });
    it('allows standalone unbound estimation but refuses unbound or differently scoped policy activation', () => {
        const f = fixture();
        const { binding: _, ...unboundBody } = body(f.toSnapshot);
        const unbound = sealLearningRecord('snapshot', unboundBody);
        const scopes = [unbound, sealLearningRecord('snapshot', { ...body(f.toSnapshot), binding: { ...f.toSnapshot.binding!, definitionDigest: digest('other-definition') } }), sealLearningRecord('snapshot', { ...body(f.toSnapshot), binding: { ...f.toSnapshot.binding!, actions: [...arms].reverse() } })];
        for (const toSnapshot of scopes) {
            const fresh = sealLearningRecord('episode', { ...body(f.fresh), comparison: { ...f.fresh.comparison!, to: toSnapshot.digest } });
            expect(assessGateEvidence({ ...f, fresh, toSnapshot }).reason).toBe('INCOMPARABLE');
        }
    });
});
