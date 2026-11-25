import type { DatabaseSync } from 'node:sqlite';
import { canonical, freeze, hash, identifier } from '../../shared/json.js';
import { capture, decodeEntry, digest, entryBody, genesis, MAX_EVENT_BYTES } from './encoding.js';
import { logError } from './store-types.js';
import type { LogEntry, LogSourceDescriptor } from './store-types.js';
import type { LogCommit, LogPosition, LogReceipt } from './types.js';

export function readHead(db: DatabaseSync, source: LogSourceDescriptor): LogPosition {
  const meta = db.prepare('SELECT head_sequence,head_digest FROM main.oar_log_meta WHERE id=1').get();
  const rows = db.prepare('SELECT COUNT(*) AS count,MIN(sequence) AS first,MAX(sequence) AS last FROM main.oar_log_events').get()!;
  if (!meta || !Number.isSafeInteger(meta.head_sequence) || Number(meta.head_sequence) < 0 || rows.count !== meta.head_sequence
    || (Number(rows.count) > 0 && (rows.first !== 1 || rows.last !== meta.head_sequence))) logError('INTEGRITY');
  try { hash(meta.head_digest); } catch { return logError('INTEGRITY'); }
  const expected = meta.head_sequence === 0 ? genesis(source)
    : db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(Number(meta.head_sequence))?.digest;
  if (meta.head_digest !== expected) logError('INTEGRITY');
  // SQL integrity work is global. Only record *decoding* has a per-page bound.
  if (db.prepare(`SELECT 1 FROM main.oar_log_requests r WHERE r.count !=
      (SELECT COUNT(*) FROM main.oar_log_events e WHERE e.request_id=r.request_id)
      OR r.first_sequence != (SELECT MIN(sequence) FROM main.oar_log_events e WHERE e.request_id=r.request_id)
      OR r.last_sequence != (SELECT MAX(sequence) FROM main.oar_log_events e WHERE e.request_id=r.request_id) LIMIT 1`).get()) logError('INTEGRITY');
  return Object.freeze({ sourceId: source.sourceId, sequence: Number(meta.head_sequence), digest: meta.head_digest as string });
}
function readRequestMetadata(db: DatabaseSync, requestId: string, source: LogSourceDescriptor) {
  const row = db.prepare(`SELECT commit_digest,first_sequence,last_sequence,count,receipt_digest,
    CASE WHEN length(receipt_json)<4096 THEN receipt_json END AS receipt_json FROM main.oar_log_requests WHERE request_id=?`).get(requestId);
  if (!row) return undefined;
  try {
    if (typeof row.receipt_json !== 'string' || digest(row.receipt_json) !== row.receipt_digest || !Number.isSafeInteger(row.count)
      || Number(row.count) < 1 || Number(row.count) > 256 || !Number.isSafeInteger(row.first_sequence) || Number(row.first_sequence) < 1
      || row.last_sequence !== Number(row.first_sequence) + Number(row.count) - 1) logError('INTEGRITY');
    hash(row.commit_digest);
    const first = db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(Number(row.first_sequence));
    const last = db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(Number(row.last_sequence));
    if (!first || !last) logError('INTEGRITY');
    const receipt: LogReceipt = { first: { sourceId: source.sourceId, sequence: Number(row.first_sequence), digest: first.digest as string },
      head: { sourceId: source.sourceId, sequence: Number(row.last_sequence), digest: last.digest as string }, count: Number(row.count) };
    if (canonical(receipt) !== row.receipt_json) logError('INTEGRITY');
    return { first_sequence: Number(row.first_sequence), last_sequence: Number(row.last_sequence), count: Number(row.count),
      commit_digest: row.commit_digest as string, receipt_json: row.receipt_json, receipt: freeze(receipt) };
  } catch { return logError('INTEGRITY'); }
}
export function readEntry(db: DatabaseSync, sequence: number, source: LogSourceDescriptor): LogEntry {
  const row = db.prepare(`SELECT sequence,request_id,ordinal,source_id,system_id,generation,run_id,agent_id,schema_id,schema_version,
    previous_digest,digest,CASE WHEN length(CAST(body_json AS BLOB))<=? THEN body_json END AS body_json
    FROM main.oar_log_events WHERE sequence=?`).get(MAX_EVENT_BYTES, sequence);
  if (!row || typeof row.body_json !== 'string') logError('INTEGRITY');
  const entry = decodeEntry(row.body_json, row.digest, source), identity = entry.record.identity;
  if (row.sequence !== entry.sequence || row.request_id !== entry.requestId || row.ordinal !== entry.ordinal || row.source_id !== entry.sourceId
    || row.previous_digest !== entry.previousDigest || row.system_id !== identity.systemId || row.generation !== identity.generation
    || row.run_id !== identity.runId || row.agent_id !== identity.agentId || row.schema_id !== entry.record.schema.id || row.schema_version !== entry.record.schema.version) logError('INTEGRITY');
  const request = readRequestMetadata(db, entry.requestId, source);
  if (!request || entry.sequence !== Number(request.first_sequence) + entry.ordinal - 1 || entry.ordinal > Number(request.count)) logError('INTEGRITY');
  const pin = db.prepare(`SELECT CASE WHEN length(reference_json)<2048 THEN reference_json END AS reference_json,reference_digest
    FROM main.oar_log_payloads WHERE sequence=?`).get(sequence);
  if ('artifact' in entry.record.payload) {
    const encoded = canonical(entry.record.payload.artifact);
    if (!pin || pin.reference_json !== encoded || pin.reference_digest !== digest(encoded)) logError('INTEGRITY');
  } else if (pin) logError('INTEGRITY');
  return entry;
}
function position(entry: LogEntry): LogPosition { return { sourceId: entry.sourceId, sequence: entry.sequence, digest: entry.digest }; }
export function lookupReceipt(db: DatabaseSync, requestId: string, source: LogSourceDescriptor): { receipt: LogReceipt; commitDigest: string } | undefined {
  const row = readRequestMetadata(db, requestId, source);
  if (!row) return undefined;
  const entries: LogEntry[] = [];
  const before = Number(row.first_sequence) - 1;
  let previous = before === 0 ? genesis(source) : db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(before)?.digest;
  for (let i = 0; i < Number(row.count); i++) {
    const entry = readEntry(db, Number(row.first_sequence) + i, source);
    if (entry.requestId !== requestId || entry.ordinal !== i + 1 || entry.previousDigest !== previous) logError('INTEGRITY');
    entries.push(entry); previous = entry.digest;
  }
  const receipt = freeze({ first: position(entries[0]!), head: position(entries.at(-1)!), count: entries.length });
  const input = capture({ requestId, records: entries.map(entry => entry.record) }, source);
  if (canonical(receipt) !== row.receipt_json || digest(canonical(input)) !== row.commit_digest) logError('INTEGRITY');
  return { receipt, commitDigest: row.commit_digest as string };
}
export function appendRecords(db: DatabaseSync, commit: LogCommit, source: LogSourceDescriptor): LogReceipt {
  const head = readHead(db, source), existing = lookupReceipt(db, commit.requestId, source), commitDigest = digest(canonical(commit));
  if (existing) { if (existing.commitDigest !== commitDigest) logError('REQUEST_CONFLICT'); return existing.receipt; }
  if (!Number.isSafeInteger(head.sequence + commit.records.length)) logError('INTEGRITY');
  const entries: LogEntry[] = []; let previous = head.digest;
  for (let index = 0; index < commit.records.length; index++) {
    const record = commit.records[index]!;
    for (const causal of record.causal) if (causal.sourceId === source.sourceId) {
      const known = entries.find(entry => entry.sequence === causal.sequence)
        ?? db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(causal.sequence);
      if (!known || known.digest !== causal.digest) logError('INVALID_INPUT');
    }
    const body = entryBody(source, head.sequence + index + 1, commit.requestId, index + 1, previous, record);
    const entry = { ...body, digest: digest(canonical(body)) }; entries.push(entry); previous = entry.digest;
  }
  const receipt = freeze({ first: position(entries[0]!), head: position(entries.at(-1)!), count: entries.length }), encodedReceipt = canonical(receipt);
  db.prepare('INSERT INTO main.oar_log_requests VALUES(?,?,?,?,?,?,?)').run(commit.requestId, commitDigest, receipt.first.sequence, receipt.head.sequence, receipt.count, encodedReceipt, digest(encodedReceipt));
  const insert = db.prepare('INSERT INTO main.oar_log_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const entry of entries) {
    const identity = entry.record.identity, { digest: _, ...body } = entry;
    insert.run(entry.sequence, entry.requestId, entry.ordinal, entry.sourceId, identity.systemId, identity.generation,
      identity.runId, identity.agentId, entry.record.schema.id, entry.record.schema.version, entry.previousDigest, entry.digest, canonical(body));
    if ('artifact' in entry.record.payload) {
      const ref = canonical(entry.record.payload.artifact);
      db.prepare('INSERT INTO main.oar_log_payloads VALUES(?,?,?)').run(entry.sequence, ref, digest(ref));
    }
  }
  const update = db.prepare('UPDATE main.oar_log_meta SET head_sequence=?,head_digest=? WHERE id=1 AND head_sequence=? AND head_digest=?')
    .run(receipt.head.sequence, receipt.head.digest, head.sequence, head.digest);
  if (update.changes !== 1) logError('INTEGRITY');
  return receipt;
}
export function requestIdentifier(value: unknown): asserts value is string { try { identifier(value); } catch { logError('INVALID_INPUT'); } }
