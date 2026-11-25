import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../shared/json.js';
import { digest, genesis } from './encoding.js';
import { logError } from './store-types.js';
import type { LogSourceDescriptor } from './store-types.js';

export const LOG_APPLICATION_ID = 0x4f41524c;
export const LOG_SCHEMA_VERSION = 1;
const integer = 'BETWEEN 1 AND 9007199254740991';
export const LOG_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE oar_log_meta (id INTEGER PRIMARY KEY CHECK(id=1), descriptor_json TEXT NOT NULL,
    descriptor_digest TEXT NOT NULL, head_sequence INTEGER NOT NULL CHECK(head_sequence BETWEEN 0 AND 9007199254740991),
    head_digest TEXT NOT NULL) STRICT`,
  `CREATE TABLE oar_log_requests (request_id TEXT PRIMARY KEY NOT NULL, commit_digest TEXT NOT NULL,
    first_sequence INTEGER NOT NULL CHECK(first_sequence ${integer}), last_sequence INTEGER NOT NULL CHECK(last_sequence ${integer}),
    count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 256 AND last_sequence=first_sequence+count-1),
    receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL) STRICT`,
  `CREATE TABLE oar_log_events (sequence INTEGER PRIMARY KEY CHECK(sequence ${integer}),
    request_id TEXT NOT NULL REFERENCES oar_log_requests(request_id), ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 256),
    source_id TEXT NOT NULL, system_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation ${integer}),
    run_id TEXT NOT NULL, agent_id TEXT NOT NULL, schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
    previous_digest TEXT NOT NULL, digest TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)
      AND source_id IS json_extract(body_json,'$.sourceId') AND sequence IS json_extract(body_json,'$.sequence')
      AND request_id IS json_extract(body_json,'$.requestId') AND ordinal IS json_extract(body_json,'$.ordinal')
      AND previous_digest IS json_extract(body_json,'$.previousDigest')
      AND system_id IS json_extract(body_json,'$.record.identity.systemId')
      AND generation IS json_extract(body_json,'$.record.identity.generation')
      AND run_id IS json_extract(body_json,'$.record.identity.runId') AND agent_id IS json_extract(body_json,'$.record.identity.agentId')
      AND schema_id IS json_extract(body_json,'$.record.schema.id') AND schema_version IS json_extract(body_json,'$.record.schema.version')),
    UNIQUE(request_id,ordinal)) STRICT`,
  `CREATE TABLE oar_log_payloads (sequence INTEGER PRIMARY KEY REFERENCES oar_log_events(sequence),
    reference_json TEXT NOT NULL, reference_digest TEXT NOT NULL) STRICT`,
  ...['events', 'requests', 'payloads'].flatMap(table => ['UPDATE', 'DELETE'].map(operation =>
    `CREATE TRIGGER oar_log_${table}_${operation.toLowerCase()} BEFORE ${operation} ON oar_log_${table} BEGIN SELECT RAISE(ABORT,'immutable execution log'); END`)),
  `CREATE TRIGGER oar_log_meta_delete BEFORE DELETE ON oar_log_meta BEGIN SELECT RAISE(ABORT,'immutable execution log'); END`,
  `CREATE TRIGGER oar_log_meta_descriptor BEFORE UPDATE OF descriptor_json,descriptor_digest,id ON oar_log_meta BEGIN SELECT RAISE(ABORT,'immutable execution log'); END`,
]);
const expected = new Map(LOG_DDL.map(sql => [sql.match(/^CREATE (?:TABLE|TRIGGER) (\w+)/)![1]!, sql]));
expected.set('sqlite_autoindex_oar_log_requests_1', ''); expected.set('sqlite_autoindex_oar_log_events_1', '');
export function installLogSchema(db: DatabaseSync, systemId: string): LogSourceDescriptor {
  const existing = db.prepare("SELECT name FROM main.sqlite_schema WHERE name GLOB 'oar_log_*'").all();
  if (existing.length) return validateLogSchema(db, systemId);
  // A caller-owned transaction is the only enrollment boundary; partial namespace is never reset.
  for (const sql of LOG_DDL) db.exec(sql);
  const source = Object.freeze({ format: 1 as const, sourceId: randomUUID(), systemId });
  const encoded = canonical(source);
  db.prepare('INSERT INTO main.oar_log_meta VALUES(1,?,?,0,?)').run(encoded, digest(encoded), genesis(source));
  return source;
}
export function validateLogSchema(db: DatabaseSync, systemId: string, standalone = false, full = true): LogSourceDescriptor {
  const rows = db.prepare(`SELECT name,tbl_name,sql FROM main.sqlite_schema ${standalone ? '' : "WHERE name GLOB 'oar_log_*' OR tbl_name GLOB 'oar_log_*'"}`).all();
  if (rows.length !== expected.size || rows.some(row => !expected.has(String(row.name)) || (row.sql ?? '') !== expected.get(String(row.name)))) logError('INTEGRITY');
  if (standalone && (db.prepare('PRAGMA main.application_id').get()!.application_id !== LOG_APPLICATION_ID
    || db.prepare('PRAGMA main.user_version').get()!.user_version !== LOG_SCHEMA_VERSION)) logError('INTEGRITY');
  if (full && (db.prepare('PRAGMA main.quick_check').all().some(row => row.quick_check !== 'ok')
    || db.prepare('PRAGMA main.foreign_key_check(oar_log_events)').all().length
    || db.prepare('PRAGMA main.foreign_key_check(oar_log_payloads)').all().length)) logError('INTEGRITY');
  const meta = db.prepare('SELECT descriptor_json,descriptor_digest FROM main.oar_log_meta WHERE id=1').get();
  if (!meta || typeof meta.descriptor_json !== 'string' || meta.descriptor_json.length > 2048 || digest(meta.descriptor_json) !== meta.descriptor_digest) logError('INTEGRITY');
  try {
    const source = JSON.parse(meta.descriptor_json) as LogSourceDescriptor;
    if (!source || canonical(source) !== meta.descriptor_json || Object.keys(source).sort().join(',') !== 'format,sourceId,systemId'
      || source.format !== 1 || typeof source.sourceId !== 'string' || !/^[\da-f-]{36}$/.test(source.sourceId) || source.systemId !== systemId) logError('INTEGRITY');
    return Object.freeze(source);
  } catch { return logError('INTEGRITY'); }
}
