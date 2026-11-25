import type { DatabaseSync } from 'node:sqlite';
import { digest, freeze } from '../../shared/json.js';
import type { EvidenceMap, LearningPointer } from './types.js';
import { pointer as validatePointer } from './validation-shapes.js';
type ReadRecord = <K extends keyof EvidenceMap>(kind: K, id: string) => EvidenceMap[K] | undefined;
/** The pointer is a materialized view of immutable successful gate commits, never independent authority. */
export class LearningHistory {
    #version = -1;
    readonly #cache = new Map<string, LearningPointer>();
    invalidate(): void { this.#cache.clear(); }
    pointer(db: DatabaseSync, domain: string, read: ReadRecord): LearningPointer {
        const version = Number(db.prepare('PRAGMA data_version').get()!.data_version);
        if (version !== this.#version) {
            this.#cache.clear();
            this.#version = version;
        }
        const row = db.prepare('SELECT generation,active,previous FROM pointers WHERE domain=?').get(domain);
        const value: LearningPointer = row ? { generation: Number(row.generation), active: row.active === null ? null : String(row.active), previous: row.previous === null ? null : String(row.previous) } : { generation: 0, active: null, previous: null };
        validatePointer(value);
        const cached = this.#cache.get(domain);
        if (cached) {
            if (digest(cached) !== digest(value))
                throw new Error('Pointer generation changed without committed history');
            return cached;
        }
        let derived: LearningPointer = { generation: 0, active: null, previous: null }, lastAt = 0;
        const commits = db.prepare("SELECT id FROM records WHERE domain=? AND kind='gate-commit' AND json_extract(json,'$.status') IN ('promoted','rolled-back') ORDER BY json_extract(json,'$.after.generation')").all(domain);
        for (const row of commits) {
            const c = read('gate-commit', String(row.id)), gate = c ? read('gate', c.id) : undefined;
            if (!c || !gate || c.domain !== domain || gate.domain !== domain || c.gateDigest !== gate.digest || digest(c.before) !== digest(derived) || gate.expectedGeneration !== derived.generation || gate.from !== derived.active || gate.outcome === 'keep' || gate.outcome !== gate.mode || c.status !== (gate.mode === 'promote' ? 'promoted' : 'rolled-back') || c.createdAt < gate.createdAt || c.createdAt < lastAt || gate.mode === 'rollback' && (derived.generation === 0 || gate.to !== derived.previous) || gate.mode === 'promote' && gate.to === null)
                throw new Error('Invalid committed pointer generation history');
            const next = { generation: derived.generation + 1, active: gate.to, previous: derived.active };
            if (digest(c.after) !== digest(next))
                throw new Error('Invalid committed pointer transition');
            const consumed = db.prepare('SELECT gate_id FROM consumed WHERE domain=? AND episode_id=?').get(domain, gate.fresh.episodeId);
            if (consumed?.gate_id !== gate.id)
                throw new Error('Pointer gate has no consumed fresh evidence');
            for (const id of [next.active, next.previous])
                if (id !== null && read('snapshot', id)?.domain !== domain)
                    throw new Error('Pointer references missing domain snapshot');
            derived = next;
            lastAt = c.createdAt;
        }
        if (digest(value) !== digest(derived) || row && derived.generation === 0)
            throw new Error('Pointer has no matching committed generation history');
        const result = freeze(derived);
        this.#cache.set(domain, result);
        return result;
    }
}
