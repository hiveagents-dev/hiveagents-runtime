import { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../shared/json.js';
import { validateLearningRecord } from './validation.js';
export const LEARNING_APPLICATION_ID = 0x4f41524c;
export const V1_SCHEMA = `
CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,domain TEXT NOT NULL,digest TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT;
CREATE INDEX records_domain ON records(domain,kind);
CREATE TABLE observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,domain TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,task_digest TEXT NOT NULL,split TEXT NOT NULL,digest TEXT NOT NULL,json TEXT NOT NULL) STRICT;
CREATE INDEX observations_domain ON observations(domain,sequence);
CREATE TABLE task_claims(domain TEXT NOT NULL,task_digest TEXT NOT NULL,split TEXT NOT NULL,episode_id TEXT,PRIMARY KEY(domain,task_digest)) STRICT;
CREATE TABLE pointers(domain TEXT PRIMARY KEY,generation INTEGER NOT NULL,active TEXT,previous TEXT) STRICT;
CREATE TABLE consumed(domain TEXT NOT NULL,episode_id TEXT NOT NULL,gate_id TEXT NOT NULL,PRIMARY KEY(domain,episode_id)) STRICT;
PRAGMA application_id=${LEARNING_APPLICATION_ID}; PRAGMA user_version=1;`;
export const V2_ADDITIONS = `
CREATE TABLE cell_ids(kind TEXT NOT NULL CHECK(kind IN ('attempt','observation')),id TEXT NOT NULL,domain TEXT NOT NULL,episode_id TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT;
CREATE INDEX observations_ids_domain ON observations(id,domain,sequence);
CREATE INDEX observations_quality ON observations(domain,split,json_extract(json,'$.quality.state'),sequence DESC);
CREATE INDEX observations_features ON observations(domain,split,json_extract(json,'$.quality.state'),json_extract(json,'$.features.schema'),json_array_length(json_extract(json,'$.features.values')),sequence DESC);
CREATE INDEX observations_actions ON observations(domain,split,json_extract(json,'$.quality.state'),json_extract(json,'$.features.schema'),json_array_length(json_extract(json,'$.features.values')),json_extract(json,'$.action.key'),sequence DESC);
CREATE INDEX observations_schema ON observations(domain,json_extract(json,'$.features.schema'),json_array_length(json_extract(json,'$.features.values')),sequence DESC);
CREATE INDEX committed_generations ON records(domain,json_extract(json,'$.after.generation')) WHERE kind='gate-commit' AND json_extract(json,'$.status') IN ('promoted','rolled-back');
PRAGMA user_version=2;`;
export const LEARNING_SCHEMA = V1_SCHEMA + V2_ADDITIONS;
export function learningCatalog(db: DatabaseSync): string { return canonical(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()); }
function catalogFor(sql: string): string {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(sql);
        return learningCatalog(db);
    }
    finally {
        db.close();
    }
}
export const LEARNING_CATALOG = catalogFor(LEARNING_SCHEMA);
export const LEARNING_V1_CATALOG = catalogFor(V1_SCHEMA);
/** Upgrade only the exact recognized prior layout; conflicting historic reservations fail atomically. */
export function migrateLearningDatabase(db: DatabaseSync): void {
    db.exec('BEGIN IMMEDIATE');
    try {
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        const schema = learningCatalog(db);
        if (version === 2) {
            if (schema !== LEARNING_CATALOG)
                throw new Error('Learning database integrity/version/schema failure');
        }
        else if (version === 1) {
            if (schema !== LEARNING_V1_CATALOG)
                throw new Error('Learning database integrity/version/schema failure');
            db.exec(V2_ADDITIONS);
            for (const row of db.prepare("SELECT id,domain,digest,json FROM records WHERE kind='episode'").all()) {
                const e = validateLearningRecord('episode', JSON.parse(String(row.json)));
                if (e.id !== row.id || e.domain !== row.domain || e.digest !== row.digest)
                    throw new Error('Invalid historic episode identity');
                for (const cell of e.cells)
                    for (const kind of ['attempt', 'observation'] as const) {
                        const id = kind === 'attempt' ? cell.attemptId : cell.observationId;
                        const existing = kind === 'attempt' ? db.prepare("SELECT json FROM records WHERE kind='attempt' AND id=?").get(id) : db.prepare('SELECT json FROM observations WHERE id=?').get(id);
                        if (existing) {
                            const record = validateLearningRecord(kind, JSON.parse(String(existing.json)));
                            if (record.domain !== e.domain || record.episodeId !== e.id || record.taskDigest !== cell.taskDigest || record.action.key !== cell.actionKey || record.repetition !== cell.repetition)
                                throw new Error('Conflicting historic cell reservation');
                        }
                        db.prepare('INSERT INTO cell_ids(kind,id,domain,episode_id) VALUES (?,?,?,?)').run(kind, id, e.domain, e.id);
                    }
            }
            for (const row of db.prepare("SELECT json FROM records WHERE kind='attempt'").all()) {
                const a = validateLearningRecord('attempt', JSON.parse(String(row.json)));
                if (a.split === 'train') {
                    const terminal = db.prepare('SELECT id FROM observations WHERE attempt_id=?').get(a.id);
                    if (terminal && terminal.id !== a.observationId)
                        throw new Error('Conflicting historic planned terminal ID');
                    db.prepare("INSERT INTO cell_ids(kind,id,domain,episode_id) VALUES ('observation',?,?,?)").run(a.observationId, a.domain, '');
                }
            }
        }
        else
            throw new Error('Learning database integrity/version/schema failure');
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
