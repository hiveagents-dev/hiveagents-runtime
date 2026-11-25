import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../src/routing/json.js';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
import { DEFAULT_LEARNING_POLICY, buildSnapshot } from '../../src/routing/learning/estimator.js';
import { sealLearningRecord, validateLearningRecord } from '../../src/routing/learning/validation.js';
import type { LearningAction, LearningAttempt, LearningDecision } from '../../src/routing/learning/types.js';
const body = <T extends {
    digest: string;
}>(v: T): Omit<T, 'digest'> => { const { digest: _, ...b } = v; return b; };
const domain = digest('source/scorer/protocol'), features = { schema: 'unit', values: [1, 0] };
const ab = { model: 'a', evidenceScope: 'model' as const, provider: 'p', modelId: 'a', optionsDigest: digest({}), executionDigest: digest('cli') };
const action: LearningAction = { id: 'a', ...ab, key: digest(ab) };
function decision(id = 'd'): LearningDecision { return sealLearningRecord('decision', { format: 1, id, domain, createdAt: 1, taskDigest: digest(id), featuresDigest: digest(features), definitionDigest: digest('def'), policy: null, mode: 'auto', reason: 'INCUMBENT', candidates: [{ id: 'a', model: 'a', provider: 'p', modelId: 'a', status: 'eligible', code: 'READY', action }], predictions: [], selected: action, nativeDispatches: 0 }); }
function attempt(d: LearningDecision, id = 'a'): LearningAttempt { return sealLearningRecord('attempt', { format: 1, id, domain, decisionId: d.id, decisionDigest: d.digest, action, taskDigest: d.taskDigest, features, split: 'train', observationId: 'o', startedAt: 2 }); }
function observation(a: LearningAttempt, id = 'o') { return sealLearningRecord('observation', { format: 1, id, domain, attemptId: a.id, decisionId: a.decisionId, decisionDigest: a.decisionDigest, action: a.action, taskDigest: a.taskDigest, features: a.features, split: 'train', outcome: 'completed', quality: { state: 'verified', value: .9, passed: true }, latency: { state: 'observed', durationMs: 3 }, createdAt: 4 }); }
const stores: SqliteLearningStore[] = [];
afterEach(() => {
    for (const s of stores.splice(0))
        s.close();
});
function open(path = join(mkdtempSync(join(tmpdir(), 'learn-')), 'private', 'evidence.sqlite')) { const s = new SqliteLearningStore(path); stores.push(s); return { s, path }; }
describe('private immutable SQLite learning ledger', () => {
    it('persists pending starts across restart and finalizes exact terminal retry once', async () => {
        const { s, path } = open();
        const d = decision(), a = attempt(d);
        await s.put('decision', d.id, d);
        await s.put('attempt', a.id, a);
        expect(await s.pending(domain)).toHaveLength(1);
        s.close();
        stores.splice(stores.indexOf(s), 1);
        const next = open(path).s;
        expect(await next.pending(domain)).toHaveLength(1);
        const o = observation(a);
        expect((await next.appendObservation(o)).sequence).toBe(1);
        expect((await next.appendObservation(o)).sequence).toBe(1);
        expect(await next.pending(domain)).toEqual([]);
        await expect(next.appendObservation(sealLearningRecord('observation', { ...body(o), quality: { state: 'verified', value: .1, passed: false } }))).rejects.toThrow();
        expect(await next.highWater(digest('other'))).toBe(0);
        expect((await next.observations(domain))[0]?.observation.digest).toBe(o.digest);
    });
    it('rejects unknown fields, accessors, proxies, bad action keys and orphan/crossbound evidence', async () => {
        const { s } = open();
        const d = decision(), a = attempt(d);
        let called = false;
        const getter = { ...d };
        Object.defineProperty(getter, 'taskDigest', { get() { called = true; return d.taskDigest; }, enumerable: true });
        expect(() => validateLearningRecord('decision', getter)).toThrow();
        expect(called).toBe(false);
        expect(() => validateLearningRecord('decision', new Proxy(d, {}))).toThrow();
        expect(() => sealLearningRecord('decision', { ...body(d), unknown: 1 } as any)).toThrow();
        expect(() => sealLearningRecord('attempt', { ...body(a), action: { ...action, key: digest('wrong') } })).toThrow();
        await expect(s.put('attempt', a.id, a)).rejects.toThrow();
        await s.put('decision', d.id, d);
        await expect(s.put('attempt', a.id, sealLearningRecord('attempt', { ...body(a), taskDigest: digest('other') }))).rejects.toThrow();
        await expect(s.appendObservation(observation(a))).rejects.toThrow();
        await s.put('attempt', a.id, a);
        await expect(s.put('attempt', a.id, a)).rejects.toMatchObject({ code: 'LEARNING_RECORD_EXISTS' });
    });
    it('binds snapshot row references to the actual SQL rows', async () => {
        const { s } = open();
        const d = decision(), a = attempt(d);
        await s.put('decision', d.id, d);
        await s.put('attempt', a.id, a);
        const o = await s.appendObservation(observation(a));
        const snap = buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 1, [o], 5);
        await s.put('snapshot', snap.digest, snap);
        const fake = buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 1, [{ sequence: 1, observation: sealLearningRecord('observation', { ...body(o.observation), id: 'forged' }) }], 5);
        await expect(s.put('snapshot', fake.digest, fake)).rejects.toThrow();
    });
    it('uses private directory/database/WAL modes and refuses foreign files and symlinks before opening', () => {
        const { path } = open();
        expect(lstatSync(join(path, '..')).mode & 0o777).toBe(0o700);
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
        for (const ext of ['-wal', '-shm'])
            expect(lstatSync(path + ext).mode & 0o777).toBe(0o600);
        const dir = mkdtempSync(join(tmpdir(), 'foreign-'));
        const foreign = join(dir, 'data');
        writeFileSync(foreign, 'not-sqlite');
        expect(() => new SqliteLearningStore(foreign)).toThrow();
        expect(readFileSync(foreign, 'utf8')).toBe('not-sqlite');
        const link = join(dir, 'link');
        symlinkSync(path, link);
        expect(() => new SqliteLearningStore(link)).toThrow();
    });
});
