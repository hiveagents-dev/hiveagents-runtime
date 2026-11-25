import type { DatabaseSync } from 'node:sqlite';
import { digest, freeze, hash, identifier, jsonClone } from '../../shared/json.js';
import type { EvidenceMap, LearningAttempt, LearningEpisode, LearningGate, LearningGateCommit, LearningObservation, LearningPointer, LearningSnapshot, LearningSplit, LearningStore, PutKind, SequencedObservation } from './types.js';
import { LearningDatabase } from './store-sqlite.js';
import { validateLearningRecord, sealLearningRecord } from './validation.js';
import { LearningHistory } from './store-history.js';
import { identifier as validIdentifier } from '../../shared/json.js';
import { assessGateEvidence } from './evidence.js';
export class LearningRecordExistsError extends Error {
    readonly code = 'LEARNING_RECORD_EXISTS' as const;
    constructor() { super('Immutable learning record already exists'); this.name = 'LearningRecordExistsError'; }
}
function failure(message: string): never { throw new Error(message); }
/** Durable local evidence. Every transaction is synchronous: no callback/await crosses a SQLite lock. */
export class SqliteLearningStore implements LearningStore {
    readonly #database: LearningDatabase;
    readonly #history = new LearningHistory();
    readonly #cache = new Map<string, EvidenceMap[keyof EvidenceMap]>();
    #revision = -1;
    readonly #verifiedSnapshots = new Set<string>();
    constructor(path: string, options: {
        busyTimeoutMs?: number;
    } = {}) { this.#database = new LearningDatabase(path, options.busyTimeoutMs ?? 5000); }
    #read<K extends keyof EvidenceMap>(db: DatabaseSync, kind: K, id: string): EvidenceMap[K] | undefined {
        const revision = Number(db.prepare('PRAGMA data_version').get()!.data_version);
        if (revision !== this.#revision) {
            this.#cache.clear();
            this.#verifiedSnapshots.clear();
            this.#revision = revision;
        }
        const cacheKey = `${kind}:${id}`, cached = this.#cache.get(cacheKey);
        if (cached)
            return cached as EvidenceMap[K];
        const row = kind === 'observation' ? db.prepare('SELECT * FROM observations WHERE id=?').get(id) : db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(kind, id);
        if (!row)
            return undefined;
        const value = validateLearningRecord(kind, JSON.parse(String(row.json)));
        if (value.digest !== row.digest || value.domain !== row.domain || ('id' in value ? value.id : value.digest) !== id)
            failure('Stored learning identity mismatch');
        if (kind === 'observation') {
            const o = value as LearningObservation;
            if (o.attemptId !== row.attempt_id || o.taskDigest !== row.task_digest || o.split !== row.split)
                failure('Stored observation column mismatch');
        }
        this.#cache.set(cacheKey, value);
        if (this.#cache.size > 64)
            this.#cache.delete(this.#cache.keys().next().value!);
        return value;
    }
    #insert<K extends keyof EvidenceMap>(db: DatabaseSync, kind: K, id: string, row: EvidenceMap[K]): void { db.prepare('INSERT INTO records(kind,id,domain,digest,json) VALUES (?,?,?,?,?)').run(kind, id, row.domain, row.digest, JSON.stringify(row)); }
    #water(db: DatabaseSync, domain: string): number { return Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM observations WHERE domain=?').get(domain)!.n); }
    #pointer(db: DatabaseSync, domain: string): LearningPointer { return this.#history.pointer(db, domain, (kind, id) => { const v = this.#read(db, kind, id); if (kind === 'snapshot' && v)
        this.#snapshot(db, v as LearningSnapshot); return v; }); }
    #snapshot(db: DatabaseSync, s: LearningSnapshot, force = false): void {
        if (!force && this.#verifiedSnapshots.has(s.digest))
            return;
        if (s.through > this.#water(db, s.domain))
            failure('Snapshot cutoff exceeds domain evidence');
        for (const r of s.rows) {
            const row = db.prepare('SELECT id,digest,domain FROM observations WHERE sequence=? AND domain=?').get(r.sequence, s.domain);
            if (!row || row.id !== r.observation.id || row.digest !== r.observation.digest || this.#read(db, 'observation', String(row.id))?.digest !== r.observation.digest)
                failure('Snapshot row is not actual persisted evidence');
        }
        this.#verifiedSnapshots.add(s.digest);
        if (this.#verifiedSnapshots.size > 64)
            this.#verifiedSnapshots.delete(this.#verifiedSnapshots.values().next().value!);
    }
    #claim(db: DatabaseSync, domain: string, task: string, split: LearningSplit, episode?: string): void {
        const row = db.prepare('SELECT split,episode_id FROM task_claims WHERE domain=? AND task_digest=?').get(domain, task);
        if (row) {
            if (row.split !== split || split === 'fresh' && row.episode_id !== episode)
                failure('Task split is already protected');
            return;
        }
        db.prepare('INSERT INTO task_claims(domain,task_digest,split,episode_id) VALUES (?,?,?,?)').run(domain, task, split, episode ?? null);
    }
    #episode(db: DatabaseSync, e: LearningEpisode): void {
        if (this.#water(db, e.domain) !== e.afterSequence)
            failure('Episode must reserve the current domain cutoff');
        if (e.kind === 'fresh') {
            const c = e.comparison!, current = this.#pointer(db, e.domain), fixed = this.#read(db, 'episode', c.fixedEpisodeId);
            if (c.expectedGeneration !== current.generation || c.from !== current.active || c.operation === 'rollback' && (current.generation < 1 || c.to !== current.previous))
                failure('Fresh comparison must match the current pointer generation');
            if (!fixed || fixed.kind !== 'fixed' || fixed.domain !== e.domain || e.createdAt < fixed.createdAt)
                failure('Missing fixed suite');
            if (e.definitionDigest !== fixed.definitionDigest || e.protocolDigest !== fixed.protocolDigest || digest(e.arms) !== digest(fixed.arms) || e.fallbackId !== fixed.fallbackId || e.repetitions !== fixed.repetitions)
                failure('Incomparable fixed suite');
            if (c.operation === 'promote' && c.to === null)
                failure('Promotion requires a snapshot');
            for (const ref of [c.from, c.to])
                if (ref !== null) {
                    const s = this.#read(db, 'snapshot', ref);
                    if (!s || s.domain !== e.domain || s.through > e.afterSequence || s.createdAt > e.createdAt || digest(s.config) !== c.configDigest)
                        failure('Missing/incomparable policy snapshot');
                    const b = s.binding;
                    if (!b || b.definitionDigest !== e.definitionDigest || digest(b.actions) !== digest(e.arms) || b.fallbackId !== e.fallbackId || b.features.schema !== e.tasks[0]!.features.schema || b.features.dimensions !== e.tasks[0]!.features.values.length)
                        failure('Policy binding does not match prospective episode');
                    this.#snapshot(db, s);
                }
            const identities = new Set([...fixed.tasks, ...e.tasks].map(t => `${t.features.schema}:${t.features.values.length}`));
            for (const ref of [c.from, c.to])
                if (ref) {
                    const s = this.#read(db, 'snapshot', ref)!;
                    for (const r of s.rows)
                        identities.add(`${r.observation.features.schema}:${r.observation.features.values.length}`);
                }
            if (identities.size !== 1)
                failure('Incomparable episode feature schema or dimensions');
            const previous = new Set(fixed.tasks.map(t => t.taskDigest));
            if (e.tasks.some(t => previous.has(t.taskDigest)))
                failure('Fresh/fixed task overlap');
        }
        for (const c of e.cells)
            for (const kind of ['attempt', 'observation'] as const) {
                const id = kind === 'attempt' ? c.attemptId : c.observationId;
                if (this.#read(db, kind, id) || db.prepare('SELECT 1 FROM cell_ids WHERE kind=? AND id=?').get(kind, id))
                    failure('Cell ID is already used or reserved');
                db.prepare('INSERT INTO cell_ids(kind,id,domain,episode_id) VALUES (?,?,?,?)').run(kind, id, e.domain, e.id);
            }
        for (const t of e.tasks) {
            if (e.kind === 'fresh' && (db.prepare('SELECT 1 FROM task_claims WHERE domain=? AND task_digest=?').get(e.domain, t.taskDigest) || db.prepare('SELECT 1 FROM observations WHERE domain=? AND task_digest=?').get(e.domain, t.taskDigest)))
                failure('Fresh input was already used');
            this.#claim(db, e.domain, t.taskDigest, e.kind, e.id);
        }
    }
    #attempt(db: DatabaseSync, a: LearningAttempt): void {
        const reservation = db.prepare("SELECT domain,episode_id FROM cell_ids WHERE kind='attempt' AND id=?").get(a.id);
        if (reservation && (a.split === 'train' || reservation.domain !== a.domain || reservation.episode_id !== a.episodeId))
            failure('Attempt ID is exclusively reserved to another episode');
        if (a.split !== 'train' && !reservation)
            failure('Episode attempt ID is not reserved');
        const d = this.#read(db, 'decision', a.decisionId);
        if (!d || d.domain !== a.domain || d.digest !== a.decisionDigest || d.taskDigest !== a.taskDigest || d.featuresDigest !== digest(a.features) || !d.selected || digest(d.selected) !== digest(a.action) || a.startedAt < d.createdAt)
            failure('Attempt must match its durable decision');
        if (a.split === 'train') {
            if (this.#read(db, 'observation', a.observationId) || db.prepare("SELECT 1 FROM cell_ids WHERE kind='observation' AND id=?").get(a.observationId))
                failure('Planned observation ID is already used or reserved');
            // Empty episode ownership is exclusively the training-start namespace; public episode IDs cannot be empty.
            db.prepare("INSERT INTO cell_ids(kind,id,domain,episode_id) VALUES ('observation',?,?,?)").run(a.observationId, a.domain, '');
            this.#claim(db, a.domain, a.taskDigest, 'train');
        }
        else {
            const e = this.#read(db, 'episode', a.episodeId!);
            if (!e || e.domain !== a.domain || e.kind !== a.split || d.mode !== 'matrix' || e.definitionDigest !== d.definitionDigest || a.startedAt < e.createdAt)
                failure('Missing/mismatched prospective episode');
            const c = e.cells.find(c => c.attemptId === a.id);
            if (!c || c.observationId !== a.observationId || c.taskDigest !== a.taskDigest || c.actionKey !== a.action.key || c.repetition !== a.repetition || digest(e.tasks.find(t => t.taskDigest === a.taskDigest)!.features) !== digest(a.features) || digest(e.arms.find(x => x.key === a.action.key)) !== digest(a.action))
                failure('Attempt outside reserved matrix cell');
        }
    }
    async put<K extends PutKind>(kind: K, id: string, value: EvidenceMap[K]): Promise<void> {
        const row = validateLearningRecord(kind, value);
        if (kind === 'snapshot') {
            hash(id);
            if (row.digest !== id)
                failure('Snapshot ID must equal digest');
        }
        else {
            identifier(id);
            if (!('id' in row) || row.id !== id)
                failure('Record ID mismatch');
        }
        this.#database.transaction(db => {
            if (this.#read(db, kind, id))
                throw new LearningRecordExistsError();
            if (kind === 'decision') {
                const d = row as EvidenceMap['decision'];
                if (d.policy !== null) {
                    const s = this.#read(db, 'snapshot', d.policy);
                    if (!s || s.domain !== d.domain)
                        failure('Decision references missing policy');
                }
            }
            else if (kind === 'attempt')
                this.#attempt(db, row as LearningAttempt);
            else if (kind === 'snapshot')
                this.#snapshot(db, row as LearningSnapshot);
            else
                this.#episode(db, row as LearningEpisode);
            this.#insert(db, kind, id, row);
        });
    }
    async get<K extends keyof EvidenceMap>(kind: K, id: string): Promise<EvidenceMap[K] | undefined> {
        identifier(id);
        return this.#database.transaction(db => {
            const v = this.#read(db, kind, id);
            if (kind === 'snapshot' && v)
                this.#snapshot(db, v as LearningSnapshot);
            return v;
        });
    }
    async highWater(domain: string): Promise<number> { hash(domain); return this.#database.transaction(db => this.#water(db, domain)); }
    async observations(domain: string, options: {
        through?: number;
        split?: LearningSplit;
        limit?: number;
        verifiedOnly?: boolean;
        schema?: string;
        dimensions?: number;
        actionKeys?: readonly string[];
        observationIds?: readonly string[];
    } = {}): Promise<readonly SequencedObservation[]> {
        hash(domain);
        const through = options.through ?? Number.MAX_SAFE_INTEGER, limit = options.limit ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(through) || through < 0 || !Number.isSafeInteger(limit) || limit < 0 || options.split !== undefined && !['train', 'fixed', 'fresh'].includes(options.split) || options.verifiedOnly !== undefined && typeof options.verifiedOnly !== 'boolean')
            throw new TypeError('Invalid observation query');
        if (options.schema !== undefined)
            validIdentifier(options.schema);
        if (options.dimensions !== undefined && (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 512))
            throw new TypeError('Invalid feature dimensions');
        const actionKeys = options.actionKeys === undefined ? undefined : jsonClone(options.actionKeys);
        if (actionKeys !== undefined && (!Array.isArray(actionKeys) || actionKeys.length > 64 || new Set(actionKeys).size !== actionKeys.length))
            throw new TypeError('Invalid action key filter');
        actionKeys?.forEach(hash);
        const observationIds = options.observationIds === undefined ? undefined : jsonClone(options.observationIds);
        if (observationIds !== undefined && (!Array.isArray(observationIds) || observationIds.length > 8192 || new Set(observationIds).size !== observationIds.length))
            throw new TypeError('Invalid observation ID filter');
        observationIds?.forEach(identifier);
        return this.#database.transaction(db => {
            if (actionKeys?.length === 0 || observationIds?.length === 0 || limit === 0)
                return freeze([]);
            const where = ['domain=?', 'sequence<=?'], params: (string | number)[] = [domain, through];
            if (options.split !== undefined) {
                where.push('split=?');
                params.push(options.split);
            }
            if (options.verifiedOnly)
                where.push("json_extract(json,'$.quality.state')='verified'");
            if (options.schema !== undefined) {
                where.push("json_extract(json,'$.features.schema')=?");
                params.push(options.schema);
            }
            if (options.dimensions !== undefined) {
                where.push("json_array_length(json_extract(json,'$.features.values'))=?");
                params.push(options.dimensions);
            }
            if (actionKeys !== undefined) {
                where.push(`json_extract(json,'$.action.key') IN (${actionKeys.map(() => '?').join(',')})`);
                params.push(...actionKeys);
            }
            // Keep each IN list under SQLite's portable variable limit, then apply one global newest-row bound.
            const batches: (readonly string[] | undefined)[] = observationIds ? Array.from({ length: Math.ceil(observationIds.length / 256) }, (_, i) => observationIds.slice(i * 256, (i + 1) * 256)) : [undefined];
            const matches = batches.flatMap(ids => {
                const filters = [...where], args = [...params];
                if (ids) {
                    filters.push(`id IN (${ids.map(() => '?').join(',')})`);
                    args.push(...ids);
                }
                args.push(limit);
                return db.prepare(`SELECT sequence,id FROM observations ${ids ? 'INDEXED BY observations_ids_domain' : ''} WHERE ${filters.join(' AND ')} ORDER BY sequence DESC LIMIT ?`).all(...args);
            }).sort((a, b) => Number(a.sequence) - Number(b.sequence));
            return freeze(matches.slice(-limit).map(row => ({ sequence: Number(row.sequence), observation: this.#read(db, 'observation', String(row.id))! })));
        });
    }
    async appendObservation(value: LearningObservation): Promise<SequencedObservation> {
        const o = validateLearningRecord('observation', value);
        return this.#database.transaction(db => {
            const old = this.#read(db, 'observation', o.id);
            if (old) {
                if (old.digest !== o.digest)
                    failure('Conflicting terminal observation');
                const row = db.prepare('SELECT sequence FROM observations WHERE id=?').get(o.id)!;
                return freeze({ sequence: Number(row.sequence), observation: old });
            }
            const reservation = db.prepare("SELECT domain,episode_id FROM cell_ids WHERE kind='observation' AND id=?").get(o.id);
            if (reservation && (reservation.domain !== o.domain || reservation.episode_id !== (o.split === 'train' ? '' : o.episodeId)))
                failure('Observation ID is exclusively reserved to another episode');
            if (!reservation)
                failure('Episode terminal ID is not reserved');
            const a = this.#read(db, 'attempt', o.attemptId);
            if (!a || a.observationId !== o.id || a.domain !== o.domain || a.decisionId !== o.decisionId || a.decisionDigest !== o.decisionDigest || digest(a.action) !== digest(o.action) || a.taskDigest !== o.taskDigest || digest(a.features) !== digest(o.features) || a.split !== o.split || a.episodeId !== o.episodeId || a.repetition !== o.repetition || o.createdAt < a.startedAt)
                failure('Terminal observation must match durable start');
            if (o.split !== 'train') {
                const e = this.#read(db, 'episode', o.episodeId!)!, c = e.cells.find(c => c.attemptId === a.id)!;
                if (c.observationId !== o.id)
                    failure('Terminal observation ID is not reserved');
            }
            const r = db.prepare('INSERT INTO observations(id,domain,attempt_id,task_digest,split,digest,json) VALUES (?,?,?,?,?,?,?)').run(o.id, o.domain, o.attemptId, o.taskDigest, o.split, o.digest, JSON.stringify(o));
            return freeze({ sequence: Number(r.lastInsertRowid), observation: o });
        });
    }
    async pointer(domain: string): Promise<LearningPointer> { hash(domain); return this.#database.transaction(db => this.#pointer(db, domain)); }
    async pending(domain: string): Promise<readonly LearningAttempt[]> { hash(domain); return this.#database.transaction(db => freeze(db.prepare("SELECT id FROM records WHERE kind='attempt' AND domain=? AND id NOT IN (SELECT attempt_id FROM observations WHERE domain=?) ORDER BY id").all(domain, domain).map(r => this.#read(db, 'attempt', String(r.id))!))); }
    async commitGate(value: LearningGate): Promise<LearningGateCommit> {
        const gate = validateLearningRecord('gate', value);
        return this.#database.transaction(db => {
            const old = this.#read(db, 'gate', gate.id);
            if (old) {
                if (old.digest !== gate.digest)
                    throw Object.assign(new Error('Conflicting gate replay'), { code: 'LEARNING_GATE_EXISTS' });
                const commit = this.#read(db, 'gate-commit', gate.id);
                return commit ?? failure('Missing gate commit');
            }
            const fresh = this.#read(db, 'episode', gate.fresh.episodeId), fixed = this.#read(db, 'episode', gate.fixed.episodeId);
            if (!fresh || !fixed || fresh.domain !== gate.domain || fixed.domain !== gate.domain || !fresh.comparison)
                failure('Gate episodes missing');
            if (db.prepare('SELECT 1 FROM consumed WHERE domain=? AND episode_id=?').get(gate.domain, fresh.id))
                failure('Fresh episode already consumed');
            const observations: SequencedObservation[] = [];
            for (const e of [fixed, fresh])
                for (const c of e.cells) {
                    const o = this.#read(db, 'observation', c.observationId);
                    if (o) {
                        const r = db.prepare('SELECT sequence FROM observations WHERE id=? AND domain=?').get(o.id, gate.domain);
                        if (!r)
                            failure('Cross-domain cell');
                        observations.push({ sequence: Number(r.sequence), observation: o });
                    }
                }
            const fromSnapshot = gate.from === null ? undefined : this.#read(db, 'snapshot', gate.from), toSnapshot = gate.to === null ? undefined : this.#read(db, 'snapshot', gate.to);
            for (const policy of [fromSnapshot, toSnapshot])
                if (policy)
                    this.#snapshot(db, policy, true);
            const recomputed = assessGateEvidence({ id: gate.id, createdAt: gate.createdAt, domain: gate.domain, fresh, fixed, ...(fromSnapshot ? { fromSnapshot } : {}), ...(toSnapshot ? { toSnapshot } : {}), observations });
            if (recomputed.digest !== gate.digest)
                failure('Gate is not authorized by stored paired evidence');
            const before = this.#pointer(db, gate.domain);
            const prior = db.prepare("SELECT json_extract(json,'$.createdAt') AS created_at FROM records WHERE domain=? AND kind='gate-commit' AND json_extract(json,'$.status') IN ('promoted','rolled-back') ORDER BY json_extract(json,'$.after.generation') DESC LIMIT 1").get(gate.domain);
            // A logical commit clock preserves causal receipts across operating-system clock corrections.
            const committedAt = Math.max(Date.now(), gate.createdAt, Number(prior?.created_at ?? 0));
            let after = before, status: LearningGateCommit['status'] = 'kept';
            const matches = before.generation === gate.expectedGeneration && before.active === gate.from && (gate.mode !== 'rollback' || before.generation >= 1 && before.previous === gate.to);
            if (!matches)
                status = 'stale';
            else if (gate.outcome !== 'keep') {
                if (gate.mode === 'promote' && gate.to === null)
                    failure('Cannot promote null policy');
                after = freeze({ generation: before.generation + 1, active: gate.to, previous: before.active });
                status = gate.outcome === 'promote' ? 'promoted' : 'rolled-back';
                db.prepare('INSERT INTO pointers(domain,generation,active,previous) VALUES (?,?,?,?) ON CONFLICT(domain) DO UPDATE SET generation=excluded.generation,active=excluded.active,previous=excluded.previous').run(gate.domain, after.generation, after.active, after.previous);
            }
            db.prepare('INSERT INTO consumed(domain,episode_id,gate_id) VALUES (?,?,?)').run(gate.domain, fresh.id, gate.id);
            const commit = sealLearningRecord('gate-commit', { format: 1, id: gate.id, domain: gate.domain, gateDigest: gate.digest, status, before, after, createdAt: committedAt });
            this.#insert(db, 'gate', gate.id, gate);
            this.#insert(db, 'gate-commit', gate.id, commit);
            this.#history.invalidate();
            return commit;
        });
    }
    close(): void { this.#database.close(); }
}
