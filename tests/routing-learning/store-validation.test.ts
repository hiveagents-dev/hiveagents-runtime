import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../../src/routing/json.js';
import { sealLearningRecord, validateFeatures, validateLearningRecord, validatePolicyConfig } from '../../src/routing/learning/validation.js';
import { DEFAULT_LEARNING_POLICY, buildSnapshot, predict } from '../../src/routing/learning/estimator.js';
import { usage as validateUsage } from '../../src/routing/learning/validation-shapes.js';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
const domain = digest('domain'), features = { schema: 'unit', values: [1, 0] };
const ab = { model: 'a', evidenceScope: 'model' as const, provider: 'p', modelId: 'a', optionsDigest: digest({}), executionDigest: digest('cli') }, action = { id: 'a', ...ab, key: digest(ab) };
const decision = () => sealLearningRecord('decision', { format: 1, id: 'd', domain, createdAt: 1, taskDigest: digest('t'), featuresDigest: digest(features), definitionDigest: digest('def'), policy: null, mode: 'auto', reason: 'INCUMBENT', candidates: [{ id: 'a', model: 'a', provider: 'p', modelId: 'a', status: 'eligible', code: 'READY', action }], predictions: [], selected: action, nativeDispatches: 0 });
const attempt = () => { const d = decision(); return sealLearningRecord('attempt', { format: 1, id: 'a', domain, decisionId: 'd', decisionDigest: d.digest, action, taskDigest: d.taskDigest, features, split: 'train', observationId: 'o', startedAt: 2 }); };
const observation = () => { const a = attempt(); return sealLearningRecord('observation', { format: 1, id: 'o', domain, attemptId: a.id, decisionId: a.decisionId, decisionDigest: a.decisionDigest, action, taskDigest: a.taskDigest, features, split: 'train', outcome: 'completed', quality: { state: 'verified', value: 1, passed: true }, latency: { state: 'observed', durationMs: 3 }, createdAt: 3 }); };
const body = <T extends {
    digest: string;
}>(v: T): Omit<T, 'digest'> => { const { digest: _, ...b } = v; return b; };
describe('strict learning boundaries', () => {
    it.each([NaN, Infinity, -Infinity])('rejects nonfinite vector and quality %s', (value) => { expect(() => validateFeatures({ schema: 'x', values: [value] })).toThrow(); expect(() => sealLearningRecord('observation', { ...body(observation()), quality: { state: 'verified', value, passed: true } })).toThrow(); });
    it('rejects serialization hooks, nondata objects, holes, dimensions and unknown policy fields without invoking them', () => {
        let called = false;
        const toJSON = () => { called = true; return {}; };
        for (const x of [{ schema: 'x', values: [1], toJSON }, { schema: 'x', values: new Array(2) }, new Proxy(features, {}), { schema: 'x', values: [1, 1] }, { schema: 'x', values: [] }])
            expect(() => validateFeatures(x)).toThrow();
        expect(called).toBe(false);
        expect(() => validatePolicyConfig({ ...DEFAULT_LEARNING_POLICY, minFreshTasks: 0 })).toThrow();
        expect(() => validatePolicyConfig({ ...DEFAULT_LEARNING_POLICY, unknown: 1 })).toThrow();
        expect(() => validateLearningRecord('unknown' as any, decision())).toThrow();
    });
    it.each([
        { identityAfter: digest('other-cli') },
        { observedModels: ['unrelated-model'] },
        { usage: { costMeaning: 'provider-reported', perModel: { unrelated: { inputTokens: 1 } } } },
    ])('rejects verified identity mismatch but preserves honest unknown observation %#', (extra) => {
        const o = observation();
        expect(() => sealLearningRecord('observation', { ...body(o), ...extra } as any)).toThrow(/identity|model/i);
        expect(sealLearningRecord('observation', { ...body(o), ...extra, quality: { state: 'unknown', reason: 'identity-drift' }, outcome: 'identity-drift' } as any).quality.state).toBe('unknown');
        expect(sealLearningRecord('observation', { ...body(o), observedModels: [], usage: { costMeaning: 'unavailable' } }).quality.state).toBe('verified');
    });
    it('refuses hardlinked database and auxiliaries before any SQLite access', async () => {
        const root = mkdtempSync(join(tmpdir(), 'learn-hardlink-')), path = join(root, 'e.sqlite');
        let s = new SqliteLearningStore(path);
        s.close();
        linkSync(path, join(root, 'alias.sqlite'));
        expect(() => new SqliteLearningStore(path)).toThrow(/link|private/);
        expect(() => new SqliteLearningStore(join(root, 'alias.sqlite'))).toThrow(/link|private/);
        const other = join(root, 'other.sqlite');
        s = new SqliteLearningStore(other);
        try {
            linkSync(other + '-wal', join(root, 'wal-alias'));
            await expect(s.highWater(domain)).rejects.toThrow(/link|private/);
        }
        finally {
            s.close();
        }
    });
    it.each([.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -1])('rejects invalid token counts in every shared usage boundary %s', (count) => {
        expect(() => validateUsage({ costMeaning: 'unavailable', inputTokens: count })).toThrow();
        expect(() => validateUsage({ costMeaning: 'unavailable', perModel: { a: { outputTokens: count } } })).toThrow();
    });
    it('bounds per-model usage and preserves matching requested-system observations', () => {
        expect(() => validateUsage({ costMeaning: 'estimate', perModel: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['m' + i, { inputTokens: 1 }])) })).toThrow();
        expect(sealLearningRecord('observation', { ...body(observation()), identityAfter: action.executionDigest, observedModels: [action.modelId], usage: { costMeaning: 'provider-reported', perModel: { a: { inputTokens: 1 } }, reportedCostUsd: 0 } }).quality.state).toBe('verified');
    });
    it('learns explicitly requested systems with delegates without pooling them into model-scoped actions', () => {
        const base = body(observation()), { id: _, key: __, ...fields } = action;
        const systemFields = { ...fields, evidenceScope: 'requested-system' as const, optionsDigest: digest({ evidenceScope: 'requested-system' }) }, system = { id: action.id, ...systemFields, key: digest(systemFields) };
        const observedModels = ['delegate-a', 'delegate-b'], usage = { costMeaning: 'provider-reported' as const, perModel: { 'delegate-a': { inputTokens: 2 }, 'delegate-b': { outputTokens: 4 } } };
        const record = sealLearningRecord('observation', { ...base, action: system, observedModels, usage, identityAfter: system.executionDigest });
        expect(record.quality.state).toBe('verified');
        expect(record.observedModels).toEqual(observedModels);
        expect(record.usage?.perModel).toEqual(usage.perModel);
        expect(system.key).not.toBe(action.key);
        expect(() => sealLearningRecord('observation', { ...base, action: { ...action, evidenceScope: 'requested-system' } })).toThrow(/key/);
        expect(() => sealLearningRecord('observation', { ...base, action: system, observedModels, usage: { ...usage, perModel: { 'delegate-a': { inputTokens: 2 } } } })).toThrow(/model sets/);
        expect(() => sealLearningRecord('observation', { ...base, action: system, observedModels, usage, identityAfter: digest('other-cli') })).toThrow(/identity/);
    });
    it('rejects future, source/schema/shape-poisoned and unknown-quality training rows', () => {
        const o = observation(), rows = [{ sequence: 1, observation: o }];
        for (const bad of [sealLearningRecord('observation', { ...body(o), domain: digest('foreign') }), sealLearningRecord('observation', { ...body(o), quality: { state: 'unknown', reason: 'unverified' } })])
            expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 1, [{ sequence: 1, observation: bad }], 4)).toThrow();
        expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 0, rows, 4)).toThrow();
        expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 1, rows, 2)).toThrow();
        for (const f of [{ schema: 'other', values: [1, 0] }, { schema: 'unit', values: [1, 0, 0] }]) {
            const changed = sealLearningRecord('observation', { ...body(o), id: 'other', features: f });
            expect(() => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 2, [...rows, { sequence: 2, observation: changed }], 4)).toThrow();
        }
    });
    it('treats right-censored latency and unavailable costs as unknown metrics', () => {
        const o = observation();
        const rows = Array.from({ length: 12 }, (_, i) => ({ sequence: i + 1, observation: sealLearningRecord('observation', { ...body(o), id: `o${i}`, taskDigest: digest(i), latency: { state: 'right-censored', durationMs: 1 }, usage: { costMeaning: 'unavailable' } }) }));
        for (const objective of ['cost', 'latency'] as const) {
            const s = buildSnapshot(domain, { ...DEFAULT_LEARNING_POLICY, objective }, 12, rows, 4), p = predict(s, features, [action], 4)[0]!;
            expect(p.reason).toBe('unknown-metric');
            expect(p.costUsd).toBeUndefined();
            expect(p.latencyMs).toBeUndefined();
        }
    });
    it('rejects cross-domain/action finalization and second terminal ID for a start', async () => {
        const s = new SqliteLearningStore(join(mkdtempSync(join(tmpdir(), 'learn-bound-')), 'e.sqlite'));
        try {
            const d = decision(), a = attempt(), o = observation();
            await s.put('decision', 'd', d);
            await s.put('attempt', 'a', a);
            await expect(s.appendObservation(sealLearningRecord('observation', { ...body(o), domain: digest('foreign') }))).rejects.toThrow();
            const b = { ...ab, model: 'b', modelId: 'b' };
            await expect(s.appendObservation(sealLearningRecord('observation', { ...body(o), action: { id: 'b', ...b, key: digest(b) } }))).rejects.toThrow();
            await s.appendObservation(o);
            await expect(s.appendObservation(sealLearningRecord('observation', { ...body(o), id: 'second' }))).rejects.toThrow();
            expect(await s.highWater(domain)).toBe(1);
        }
        finally {
            s.close();
        }
    });
    it('refuses directory/sidecar symlinks, empty/foreign SQLite files and changed schema without following them', () => {
        const root = mkdtempSync(join(tmpdir(), 'learn-path-')), target = join(root, 'target');
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, join(root, 'alias'));
        expect(() => new SqliteLearningStore(join(root, 'alias', 'missing', 'e.sqlite'))).toThrow();
        expect(existsSync(join(target, 'missing'))).toBe(false);
        const path = join(root, 'e.sqlite');
        let s = new SqliteLearningStore(path);
        s.close();
        const secret = join(root, 'secret');
        writeFileSync(secret, 'secret', { mode: 0o600 });
        symlinkSync(secret, path + '-wal');
        expect(() => new SqliteLearningStore(path)).toThrow();
        expect(readFileSync(secret, 'utf8')).toBe('secret');
        const empty = join(root, 'empty');
        writeFileSync(empty, '', { mode: 0o600 });
        expect(() => new SqliteLearningStore(empty)).toThrow();
        const foreign = join(root, 'foreign');
        const db = new DatabaseSync(foreign);
        db.exec('CREATE TABLE unrelated(value TEXT)');
        db.close();
        const bytes = readFileSync(foreign);
        expect(() => new SqliteLearningStore(foreign)).toThrow();
        expect(readFileSync(foreign)).toEqual(bytes);
        const altered = join(root, 'altered');
        s = new SqliteLearningStore(altered);
        s.close();
        const other = new DatabaseSync(altered);
        other.exec('CREATE TABLE poison(value TEXT)');
        other.close();
        expect(() => new SqliteLearningStore(altered)).toThrow(/integrity/);
    });
});
