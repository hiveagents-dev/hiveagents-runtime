import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../src/routing/json.js';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
import { DEFAULT_LEARNING_POLICY, buildSnapshot } from '../../src/routing/learning/estimator.js';
import { assessGateEvidence } from '../../src/routing/learning/evidence.js';
import { sealLearningRecord } from '../../src/routing/learning/validation.js';
import type { LearningAction, LearningEpisode, LearningSnapshot, PolicyRef } from '../../src/routing/learning/types.js';
const domain = digest('domain'), features = { schema: 'unit', values: [1, 0] }, config = DEFAULT_LEARNING_POLICY, definitionDigest = digest('def');
const body = <T extends {
    digest: string;
}>(v: T): Omit<T, 'digest'> => { const { digest: _, ...b } = v; return b; };
function arm(id: string): LearningAction { const b = { model: id, evidenceScope: 'model' as const, provider: 'p', modelId: id, optionsDigest: digest({}), executionDigest: digest('cli') }; return { id, ...b, key: digest(b) }; }
const arms = [arm('a'), arm('b')];
async function collect(s: SqliteLearningStore, task: string, a: LearningAction, q: number, id: string, e?: LearningEpisode) {
    const createdAt = (e?.createdAt ?? 1) + 1;
    const cell = e?.cells.find(c => c.taskDigest === digest(task) && c.actionKey === a.key)!;
    const d = sealLearningRecord('decision', { format: 1, id: `d${id}`, domain, createdAt, taskDigest: digest(task), featuresDigest: digest(features), definitionDigest, policy: null, mode: 'matrix', reason: e ? 'MATRIX' : 'INCUMBENT', candidates: arms.map(action => ({ ...action, status: 'eligible' as const, code: 'READY' as const, action })).map(({ key: _, optionsDigest: __, executionDigest: ___, evidenceScope: ____, ...v }) => v), predictions: [], selected: a, nativeDispatches: 0 });
    const at = sealLearningRecord('attempt', { format: 1, id: cell?.attemptId ?? `a${id}`, domain, decisionId: d.id, decisionDigest: d.digest, action: a, taskDigest: d.taskDigest, features, split: e?.kind ?? 'train', ...(e ? { episodeId: e.id, repetition: 0 } : {}), observationId: cell?.observationId ?? `o${id}`, startedAt: createdAt + 1 });
    await s.put('decision', d.id, d);
    await s.put('attempt', at.id, at);
    const o = sealLearningRecord('observation', { format: 1, id: cell?.observationId ?? `o${id}`, domain, attemptId: at.id, decisionId: d.id, decisionDigest: d.digest, action: a, taskDigest: d.taskDigest, features, split: at.split, ...(e ? { episodeId: e.id, repetition: 0 } : {}), outcome: 'completed', quality: { state: 'verified', value: q, passed: true }, latency: { state: 'observed', durationMs: 10 }, createdAt: createdAt + 2 });
    return s.appendObservation(o);
}
async function manifest(s: SqliteLearningStore, id: string, kind: 'fixed' | 'fresh', count: number, snapshot: LearningSnapshot, fixedId?: string, expectedGeneration = 0, from: PolicyRef = null, to: PolicyRef = snapshot.digest) {
    const tasks = Array.from({ length: count }, (_, i) => ({ taskDigest: digest(`${id}-${i}`), features }));
    return sealLearningRecord('episode', { format: 1, id, domain, kind, createdAt: 100 + await s.highWater(domain), definitionDigest, protocolDigest: digest('protocol'), afterSequence: await s.highWater(domain), arms, tasks, repetitions: 1, cells: tasks.flatMap((t, i) => arms.map(a => ({ taskDigest: t.taskDigest, actionKey: a.key, repetition: 0, attemptId: `a${id}-${i}-${a.id}`, observationId: `o${id}-${i}-${a.id}` }))), ...(fixedId ? { comparison: { expectedGeneration, from, to, operation: expectedGeneration ? 'rollback' as const : 'promote' as const, fixedEpisodeId: fixedId, config, configDigest: digest(config) } } : {}) });
}
async function fill(s: SqliteLearningStore, e: LearningEpisode, reverse = false) {
    for (let i = 0; i < e.tasks.length; i++)
        for (const a of arms)
            await collect(s, `${e.id}-${i}`, a, a.id === (reverse ? 'a' : 'b') ? 1 : .5, `${e.id}-${i}-${a.id}`, e);
}
async function setup() {
    const path = join(mkdtempSync(join(tmpdir(), 'learning-gate-')), 'e.sqlite'), s = new SqliteLearningStore(path);
    for (let i = 0; i < 12; i++)
        for (const a of arms)
            await collect(s, `train-${i}`, a, a.id === 'b' ? 1 : .5, `train-${i}-${a.id}`);
    const through = await s.highWater(domain), rows = await s.observations(domain);
    const snapshot = buildSnapshot(domain, config, through, rows, 50, { definitionDigest, actions: arms, features: { schema: "unit", dimensions: 2 } });
    await s.put('snapshot', snapshot.digest, snapshot);
    return { s, snapshot, path };
}
async function gate(s: SqliteLearningStore, id: string, fresh: LearningEpisode, fixed: LearningEpisode, snapshot: LearningSnapshot, rollback = false) { return assessGateEvidence({ id, createdAt: 1000, domain, fresh, fixed, ...(rollback ? { fromSnapshot: snapshot } : { toSnapshot: snapshot }), observations: (await s.observations(domain)).filter(r => r.observation.split !== 'train') }); }
describe('SQL evidence authorization and protected prospective suites', () => {
    it('promotes, prevents stale CAS overwrite, consumes fresh keep/stale, and rolls back to null predecessor', async () => {
        const { s, snapshot } = await setup();
        try {
            const fixed = await manifest(s, 'fixed', 'fixed', 2, snapshot);
            await s.put('episode', fixed.id, fixed);
            await fill(s, fixed);
            const fresh = await manifest(s, 'fresh', 'fresh', 6, snapshot, fixed.id);
            await s.put('episode', fresh.id, fresh);
            await fill(s, fresh);
            const stale = await manifest(s, 'stale', 'fresh', 6, snapshot, fixed.id);
            await s.put('episode', stale.id, stale);
            await fill(s, stale);
            const evidence = await gate(s, 'promote', fresh, fixed, snapshot);
            expect(evidence.outcome).toBe('promote');
            const receipt = await s.commitGate(evidence);
            expect(receipt.status).toBe('promoted');
            expect(await s.commitGate(evidence)).toEqual(receipt);
            expect(await s.pointer(domain)).toEqual({ generation: 1, active: snapshot.digest, previous: null });
            const staleGate = await gate(s, 'stale-gate', stale, fixed, snapshot);
            expect((await s.commitGate(staleGate)).status).toBe('stale');
            await expect(s.commitGate(sealLearningRecord('gate', { ...body(staleGate), id: 'stale-again' }))).rejects.toThrow(/consumed/);
            const fixed2 = await manifest(s, 'fixed2', 'fixed', 2, snapshot);
            await s.put('episode', fixed2.id, fixed2);
            await fill(s, fixed2, true);
            const fresh2 = await manifest(s, 'fresh2', 'fresh', 6, snapshot, fixed2.id, 1, snapshot.digest, null);
            await s.put('episode', fresh2.id, fresh2);
            await fill(s, fresh2, true);
            const rollback = await gate(s, 'rollback', fresh2, fixed2, snapshot, true);
            expect(rollback.outcome).toBe('rollback');
            expect((await s.commitGate(rollback)).status).toBe('rolled-back');
            expect(await s.pointer(domain)).toEqual({ generation: 2, active: null, previous: snapshot.digest });
        }
        finally {
            s.close();
        }
    });
    it('reserves entire Cartesian holdouts before dispatch, rejects leakage/fabricated gates and consumes incomplete keep', async () => {
        const { s, snapshot } = await setup();
        try {
            const fixed = await manifest(s, 'fixed', 'fixed', 2, snapshot);
            await s.put('episode', fixed.id, fixed);
            await expect(collect(s, 'fixed-0', arms[0]!, 1, 'leak')).rejects.toThrow(/protected/);
            const missing = body(await manifest(s, 'bad', 'fresh', 6, snapshot, fixed.id));
            expect(() => sealLearningRecord('episode', { ...missing, cells: missing.cells.slice(1) })).toThrow(/Cartesian/);
            const fresh = await manifest(s, 'fresh', 'fresh', 6, snapshot, fixed.id);
            await s.put('episode', fresh.id, fresh);
            const incomplete = await gate(s, 'incomplete', fresh, fixed, snapshot);
            expect(incomplete.reason).toBe('INCOMPLETE');
            const forged = sealLearningRecord('gate', { ...body(incomplete), reason: 'SUPPORTED', outcome: 'promote' });
            await expect(s.commitGate(forged)).rejects.toThrow(/not authorized/);
            expect((await s.commitGate(incomplete)).status).toBe('kept');
            await expect(s.commitGate(sealLearningRecord('gate', { ...body(incomplete), id: 'new' }))).rejects.toThrow(/consumed/);
            const reuse = body(await manifest(s, 'reuse', 'fresh', 6, snapshot, fixed.id));
            await expect(s.put('episode', 'reuse', sealLearningRecord('episode', { ...reuse, tasks: fresh.tasks, cells: fresh.cells.map(c => ({ ...c, attemptId: `r${c.attemptId}`, observationId: `r${c.observationId}` })) }))).rejects.toThrow(/already used/);
        }
        finally {
            s.close();
        }
    });
    it('reserves globally unique cell starts and terminal IDs before dispatch', async () => {
        const { s, snapshot } = await setup();
        try {
            const fixed = await manifest(s, 'fixed-ids', 'fixed', 2, snapshot);
            await s.put('episode', fixed.id, fixed);
            await fill(s, fixed);
            const other = await manifest(s, 'other-ids', 'fixed', 2, snapshot);
            for (const key of ['attemptId', 'observationId'] as const) {
                const cells = other.cells.map((c, i) => ({ ...c, [key]: fixed.cells[i]![key] }));
                await expect(s.put('episode', other.id, sealLearningRecord('episode', { ...body(other), cells }))).rejects.toThrow(/reserv|exist|used|unique/i);
            }
            const prospective = await manifest(s, 'future-ids', 'fixed', 2, snapshot);
            await s.put('episode', prospective.id, prospective);
            const target = prospective.cells[0]!;
            const task = 'unrelated-train', a = arms[0]!, d = sealLearningRecord('decision', { format: 1, id: 'reserved-decision', domain, createdAt: 1, taskDigest: digest(task), featuresDigest: digest(features), definitionDigest, policy: null, mode: 'auto', reason: 'INCUMBENT', candidates: [{ id: a.id, model: a.model, provider: a.provider, modelId: a.modelId, status: 'eligible', code: 'READY', action: a }], predictions: [], selected: a, nativeDispatches: 0 });
            await s.put('decision', d.id, d);
            await expect(s.put('attempt', target.attemptId, sealLearningRecord('attempt', { format: 1, id: target.attemptId, domain, decisionId: d.id, decisionDigest: d.digest, action: a, taskDigest: d.taskDigest, features, split: 'train', observationId: 'unrelated-observation', startedAt: 2 }))).rejects.toThrow(/reserv/i);
        }
        finally {
            s.close();
        }
    });
    it('rejects syntactically valid derived pointers with no matching committed generation history', async () => {
        const { s, snapshot } = await setup();
        try {
            const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
            let db: DatabaseSync | undefined;
            try {
                await s.pointer(domain);
                db = prepare.mock.contexts.find(x => x instanceof DatabaseSync) as DatabaseSync;
                db.prepare('INSERT INTO pointers(domain,generation,active,previous) VALUES (?,?,?,?)').run(domain, 1, snapshot.digest, null);
            }
            finally {
                prepare.mockRestore();
            }
            await expect(s.pointer(domain)).rejects.toThrow(/history|commit|generation/);
        }
        finally {
            s.close();
        }
    });
    it('bounds parsed rows in indexed observation queries and does not quick-check the whole database per operation', async () => {
        const { s } = await setup();
        const parse = vi.spyOn(JSON, 'parse'), prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
        try {
            const rows = await s.observations(domain, { split: 'train', verifiedOnly: true, limit: 3, schema: 'unit', dimensions: 2, actionKeys: [arms[0]!.key] } as any);
            expect(rows).toHaveLength(3);
            expect(rows.every(r => r.observation.action.key === arms[0]!.key)).toBe(true);
            expect(parse.mock.calls.length).toBeLessThanOrEqual(3);
            expect(prepare.mock.calls.some(([sql]) => sql.includes('quick_check'))).toBe(false);
            expect(prepare.mock.calls.some(([sql]) => sql.includes('LIMIT'))).toBe(true);
            const sql = prepare.mock.calls.find(([sql]) => sql.includes('ORDER BY sequence DESC LIMIT'))![0], db = prepare.mock.contexts.find(x => x instanceof DatabaseSync) as DatabaseSync;
            const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(domain, Number.MAX_SAFE_INTEGER, 'train', 'unit', 2, arms[0]!.key, 3);
            expect(plan.some(row => String(row.detail).includes('observations_actions'))).toBe(true);
            expect(await s.observations(domain, { limit: 3, actionKeys: [] })).toEqual([]);
            expect(await s.observations(domain, { schema: 'absent', dimensions: 2, limit: 3 })).toEqual([]);
            await expect(s.observations(domain, { actionKeys: ['not-a-sha'] })).rejects.toThrow();
        }
        finally {
            parse.mockRestore();
            prepare.mockRestore();
            s.close();
        }
    });
    it('cannot reserve a future rollback generation or a newly stale promotion manifest', async () => {
        const { s, snapshot } = await setup();
        try {
            const fixed = await manifest(s, 'fixed-causal', 'fixed', 2, snapshot);
            await s.put('episode', fixed.id, fixed);
            await fill(s, fixed);
            const future = await manifest(s, 'future-rollback', 'fresh', 6, snapshot, fixed.id, 1, snapshot.digest, null);
            await expect(s.put('episode', future.id, future)).rejects.toThrow(/pointer|generation|current/i);
            const fresh = await manifest(s, 'current-promote', 'fresh', 6, snapshot, fixed.id);
            await s.put('episode', fresh.id, fresh);
            await fill(s, fresh);
            await s.commitGate(await gate(s, 'causal-promote', fresh, fixed, snapshot));
            const stale = await manifest(s, 'new-stale', 'fresh', 6, snapshot, fixed.id);
            await expect(s.put('episode', stale.id, stale)).rejects.toThrow(/pointer|generation|current/i);
        }
        finally {
            s.close();
        }
    });
    it('reads only exact domain cell IDs in bounded SQL batches with one global newest limit', async () => {
        const { s } = await setup();
        try {
            const all = await s.observations(domain), expected = all.slice(-3), observationIds = [...Array.from({ length: 8168 }, (_, i) => 'absent-' + i), ...all.map(r => r.observation.id)];
            const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
            try {
                const rows = await s.observations(domain, { observationIds, limit: 3 });
                expect(rows.map(r => r.sequence)).toEqual(expected.map(r => r.sequence));
                const queries = prepare.mock.calls.filter(([sql]) => sql.includes('SELECT sequence,id FROM observations'));
                expect(queries).toHaveLength(32);
                expect(queries.every(([sql]) => sql.includes('INDEXED BY observations_ids_domain') && (sql.match(/\?/g) ?? []).length <= 259)).toBe(true);
            }
            finally {
                prepare.mockRestore();
            }
            expect(await s.observations(digest('other-domain'), { observationIds: all.map(r => r.observation.id) })).toEqual([]);
            expect(await s.observations(domain, { observationIds: [] })).toEqual([]);
            await expect(s.observations(domain, { observationIds: ['duplicate', 'duplicate'] })).rejects.toThrow();
            await expect(s.observations(domain, { observationIds: Array.from({ length: 8193 }, (_, i) => String(i)) })).rejects.toThrow();
        }
        finally {
            s.close();
        }
    });
    it('bounds prospective Cartesian episodes before reserving their inputs', async () => {
        const { s, snapshot } = await setup();
        try {
            const e = await manifest(s, 'large', 'fixed', 1, snapshot), base = body(e), tasks = Array.from({ length: 1025 }, (_, i) => ({ taskDigest: digest(i), features }));
            expect(() => sealLearningRecord('episode', { ...base, tasks })).toThrow();
            const cells = Array.from({ length: 4097 }, (_, i) => ({ ...base.cells[0]!, attemptId: 'a' + i, observationId: 'o' + i }));
            expect(() => sealLearningRecord('episode', { ...base, cells })).toThrow();
        }
        finally {
            s.close();
        }
    });
    it('reserves the planned training terminal ID before dispatch in both directions', async () => {
        const { s, snapshot } = await setup();
        try {
            const make = async (id: string, observationId: string) => { const action = arms[0]!, d = sealLearningRecord('decision', { format: 1, id: 'd-' + id, domain, createdAt: 1, taskDigest: digest(id), featuresDigest: digest(features), definitionDigest, policy: null, mode: 'auto', reason: 'INCUMBENT', candidates: [{ id: action.id, model: action.model, provider: action.provider, modelId: action.modelId, status: 'eligible', code: 'READY', action }], predictions: [], selected: action, nativeDispatches: 0 }); await s.put('decision', d.id, d); return sealLearningRecord('attempt', { format: 1, id, observationId, domain, decisionId: d.id, decisionDigest: d.digest, action, taskDigest: d.taskDigest, features, split: 'train', startedAt: 2 }); };
            const a = await make('pending-train', 'reserved-before-dispatch');
            await s.put('attempt', a.id, a);
            const fixed = await manifest(s, 'disjoint-fixed', 'fixed', 2, snapshot), cells = fixed.cells.map((c, i) => i === 0 ? { ...c, observationId: a.observationId } : c);
            await expect(s.put('episode', fixed.id, sealLearningRecord('episode', { ...body(fixed), cells }))).rejects.toThrow(/reserved|used|exist/);
            const prospective = await manifest(s, 'future-fixed', 'fixed', 2, snapshot);
            await s.put('episode', prospective.id, prospective);
            const b = await make('pending-train2', prospective.cells[0]!.observationId);
            await expect(s.put('attempt', b.id, b)).rejects.toThrow(/reserved/);
            const wrong = sealLearningRecord('observation', { format: 1, id: 'unplanned-id', domain, attemptId: a.id, decisionId: a.decisionId, decisionDigest: a.decisionDigest, action: a.action, taskDigest: a.taskDigest, features, split: 'train', outcome: 'completed', quality: { state: 'verified', value: 1, passed: true }, latency: { state: 'observed', durationMs: 1 }, createdAt: 3 });
            await expect(s.appendObservation(wrong)).rejects.toThrow(/planned|terminal|start/);
        }
        finally {
            s.close();
        }
    });
    it.each(['before-commit', 'after-commit'])('rechecks actual snapshot source rows %s', async (when) => {
        const { s, snapshot, path } = await setup();
        try {
            const fixed = await manifest(s, 'source-fixed', 'fixed', 2, snapshot);
            await s.put('episode', fixed.id, fixed);
            await fill(s, fixed);
            const fresh = await manifest(s, 'source-fresh', 'fresh', 6, snapshot, fixed.id);
            await s.put('episode', fresh.id, fresh);
            await fill(s, fresh);
            const g = await gate(s, 'source-gate', fresh, fixed, snapshot);
            if (when === 'after-commit')
                expect((await s.commitGate(g)).status).toBe('promoted');
            const raw = new DatabaseSync(path);
            raw.prepare('DELETE FROM observations WHERE sequence=?').run(snapshot.rows[0]!.sequence);
            raw.close();
            if (when === 'before-commit')
                await expect(s.commitGate(g)).rejects.toThrow(/snapshot|persisted|evidence/i);
            else
                await expect(s.pointer(domain)).rejects.toThrow(/snapshot|persisted|evidence/i);
        }
        finally {
            s.close();
        }
    });
    it('keeps successfully committed history readable when the wall clock moves backwards', async () => {
        const { s, snapshot, path } = await setup();
        const now = vi.spyOn(Date, 'now').mockReturnValue(9000);
        try {
            const fixed = await manifest(s, 'clock-fixed', 'fixed', 2, snapshot);
            await s.put('episode', fixed.id, fixed);
            await fill(s, fixed);
            const fresh = await manifest(s, 'clock-fresh', 'fresh', 6, snapshot, fixed.id);
            await s.put('episode', fresh.id, fresh);
            await fill(s, fresh);
            const first = await s.commitGate(await gate(s, 'clock-promote', fresh, fixed, snapshot));
            expect(first.status).toBe('promoted');
            now.mockReturnValue(8500);
            const fixed2 = await manifest(s, 'clock-fixed2', 'fixed', 2, snapshot);
            await s.put('episode', fixed2.id, fixed2);
            await fill(s, fixed2, true);
            const fresh2 = await manifest(s, 'clock-fresh2', 'fresh', 6, snapshot, fixed2.id, 1, snapshot.digest, null);
            await s.put('episode', fresh2.id, fresh2);
            await fill(s, fresh2, true);
            const second = await s.commitGate(await gate(s, 'clock-rollback', fresh2, fixed2, snapshot, true));
            expect(second.status).toBe('rolled-back');
            expect((await s.pointer(domain)).generation).toBe(2);
            const restarted = new SqliteLearningStore(path);
            try {
                expect((await restarted.pointer(domain)).generation).toBe(2);
            }
            finally {
                restarted.close();
            }
        }
        finally {
            now.mockRestore();
            s.close();
        }
    });
});
