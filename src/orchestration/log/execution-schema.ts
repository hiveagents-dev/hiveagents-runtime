import type { DatabaseSync } from 'node:sqlite';
import { LOG_DDL } from './sqlite-schema.js';
import { executionFailure } from './execution-types.js';
export const EXECUTION_APPLICATION_ID = 0x4f415245;
export const EXECUTION_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE oar_execution_leases (kind TEXT NOT NULL CHECK(kind IN ('decision','workflow')),run_key TEXT NOT NULL,
    owner_json TEXT NOT NULL CHECK(json_valid(owner_json) AND kind IS json_extract(owner_json,'$.kind') AND run_key IS json_extract(owner_json,'$.runKey')),
    owner_digest TEXT NOT NULL,PRIMARY KEY(kind,run_key)) STRICT`,
  `CREATE TABLE oar_execution_effects (effect_id TEXT PRIMARY KEY NOT NULL,run_key TEXT NOT NULL,step_id TEXT NOT NULL,
    generation INTEGER NOT NULL,decision_id TEXT NOT NULL,association_json TEXT NOT NULL CHECK(json_valid(association_json)
      AND step_id IS json_extract(association_json,'$.stepId') AND generation IS json_extract(association_json,'$.identity.generation')),
    association_digest TEXT NOT NULL,UNIQUE(generation,decision_id)) STRICT`,
  `CREATE TABLE oar_execution_states (kind TEXT NOT NULL CHECK(kind IN ('decision','workflow')),state_key TEXT NOT NULL,
    identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),identity_digest TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),record_json TEXT NOT NULL CHECK(json_valid(record_json)),record_digest TEXT NOT NULL,
    sequence INTEGER NOT NULL REFERENCES oar_log_events(sequence),event_digest TEXT NOT NULL,request_id TEXT NOT NULL REFERENCES oar_log_requests(request_id),
    PRIMARY KEY(kind,state_key)) STRICT`,
  `CREATE TRIGGER oar_execution_effects_update BEFORE UPDATE ON oar_execution_effects BEGIN SELECT RAISE(ABORT,'immutable managed association'); END`,
  `CREATE TRIGGER oar_execution_effects_delete BEFORE DELETE ON oar_execution_effects BEGIN SELECT RAISE(ABORT,'immutable managed association'); END`,
  `CREATE TRIGGER oar_execution_states_delete BEFORE DELETE ON oar_execution_states BEGIN SELECT RAISE(ABORT,'immutable managed state'); END`,
  `CREATE TRIGGER oar_execution_states_key BEFORE UPDATE OF kind,state_key,identity_json,identity_digest ON oar_execution_states BEGIN SELECT RAISE(ABORT,'immutable managed state'); END`,
]);
const expected = new Map([...LOG_DDL, ...EXECUTION_DDL].map(sql => [sql.match(/^CREATE (?:TABLE|TRIGGER) (\w+)/)![1]!, sql]));
for (const table of ['oar_log_requests', 'oar_log_events', 'oar_execution_leases', 'oar_execution_effects', 'oar_execution_states']) expected.set(`sqlite_autoindex_${table}_1`, '');
expected.set('sqlite_autoindex_oar_execution_effects_2', '');
export function installExecutionSchema(db: DatabaseSync): void { for (const sql of EXECUTION_DDL) db.exec(sql); db.exec(`PRAGMA application_id=${EXECUTION_APPLICATION_ID}; PRAGMA user_version=1`); }
export function validateExecutionSchema(db: DatabaseSync, full = true): void {
  if (db.prepare('PRAGMA main.application_id').get()?.application_id !== EXECUTION_APPLICATION_ID
    || db.prepare('PRAGMA main.user_version').get()?.user_version !== 1) executionFailure('INTEGRITY');
  const objects = db.prepare('SELECT name,sql FROM main.sqlite_schema').all();
  if (objects.length !== expected.size || objects.some(row => !expected.has(String(row.name)) || (row.sql ?? '') !== expected.get(String(row.name)))) executionFailure('INTEGRITY');
  if (full && db.prepare('PRAGMA main.foreign_key_check').all().length) executionFailure('INTEGRITY');
}
