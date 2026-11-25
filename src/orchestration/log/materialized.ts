import { randomUUID } from 'node:crypto';
import { canonical, freeze } from '../../shared/json.js';
import { digest } from './encoding.js';
import { readEntry } from './records.js';
import { latestStatePosition } from './state-history.js';
import { decodeExecutionValue } from './execution-validation.js';
import { executionFailure } from './execution-types.js';
import { captureExecutionMetadata, executionMetadata } from './execution-metadata.js';
import type { DecisionLogMetadata, WorkflowLogMetadata } from './execution-metadata.js';
import { captureRecordBody } from './record-codec.js';
import type { RecordBody } from './record-codec.js';
import { captureLogCommit } from './validation.js';
import type { ExecutionDatabaseContext } from './execution-database.js';
import type { LogJsonValue, RunIdentity } from './types.js';
import type { LogCommit } from './types.js';
import type { PreparedLogCommit } from './store-types.js';
export interface MaterializedState {
  readonly revision: number; readonly record?: LogJsonValue; readonly recordJson: string; readonly recordDigest: string;
  readonly metadata: DecisionLogMetadata | WorkflowLogMetadata; readonly body?: RecordBody;
}
export interface PreparedState {
  readonly revision: number; readonly record: LogJsonValue; readonly recordJson: string; readonly recordDigest: string;
  readonly metadata: DecisionLogMetadata | WorkflowLogMetadata; readonly commit: LogCommit | PreparedLogCommit;
}
/** v1 keeps original JSON inline; v2 binds a private body descriptor to an adjacent pinned body event. */
export function readState(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', key: string, identity: RunIdentity): MaterializedState | undefined {
  const latest = latestStatePosition(context, kind, key);
  const row = context.db.prepare(`SELECT identity_json,identity_digest,revision,record_digest,sequence,event_digest,request_id,
    CASE WHEN length(CAST(record_json AS BLOB))<=60000 THEN record_json END AS record_json FROM main.oar_execution_states WHERE kind=? AND state_key=?`).get(kind, key);
  if (!row) {
    if (latest) executionFailure('INTEGRITY');
    return undefined;
  }
  if (!latest || latest.sequence !== row.sequence || latest.digest !== row.event_digest
    || row.identity_json !== canonical(identity) || row.identity_digest !== digest(canonical(identity)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) executionFailure('INTEGRITY');
  const event = readEntry(context.db, Number(row.sequence), context.source);
  if (event.digest !== row.event_digest || event.requestId !== row.request_id || canonical(event.record.identity) !== canonical(identity)
    || event.record.schema.id !== `oar.execution.${kind}`) executionFailure('INTEGRITY');
  let record: LogJsonValue | undefined, body: RecordBody | undefined, metadata: DecisionLogMetadata | WorkflowLogMetadata, expected;
  if (event.record.schema.version === 1) {
    record = decodeExecutionValue(row.record_json, row.record_digest); metadata = executionMetadata(kind, record);
    expected = { kind, key, revision: row.revision, recordJson: row.record_json, recordDigest: row.record_digest, metadata };
  } else if (event.record.schema.version === 2) {
    if (typeof row.record_json !== 'string') executionFailure('INTEGRITY');
    let raw: unknown; try { raw = JSON.parse(row.record_json); } catch { return executionFailure('INTEGRITY'); }
    body = captureRecordBody(raw, context.source.sourceId, identity, context.codec.maxBytes);
    if (canonical(body) !== row.record_json || body.reference.digest !== row.record_digest || !('inline' in event.record.payload)) executionFailure('INTEGRITY');
    metadata = captureExecutionMetadata(kind, (event.record.payload.inline as Record<string, unknown>).metadata);
    expected = { kind, key, revision: row.revision, recordDigest: row.record_digest, body, metadata };
    const original = readEntry(context.db, event.sequence - 1, context.source);
    const range = context.db.prepare('SELECT count,first_sequence,last_sequence FROM main.oar_log_requests WHERE request_id=?').get(event.requestId);
    if (event.ordinal !== 2 || original.ordinal !== 1 || original.requestId !== event.requestId || original.record.schema.id !== 'oar.execution.body'
      || original.record.schema.version !== 1 || original.record.type !== `${kind}.body` || canonical(original.record.identity) !== canonical(identity)
      || canonical(original.record.payload) !== canonical({ artifact: body.reference }) || range?.count !== 2
      || range.first_sequence !== original.sequence || range.last_sequence !== event.sequence) executionFailure('INTEGRITY');
  } else return executionFailure('PAYLOAD_UNAVAILABLE');
  if (event.record.type !== `${kind}.${metadata.status}` || canonical(event.record.payload) !== canonical({ inline: expected })) executionFailure('INTEGRITY');
  return freeze({ revision: Number(row.revision), ...(record !== undefined ? { record } : {}), recordJson: row.record_json as string,
    recordDigest: row.record_digest as string, metadata, ...(body ? { body } : {}) });
}
export async function hydrateState(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', state: MaterializedState, check: () => void): Promise<LogJsonValue> {
  if (!state.body) { if (state.record === undefined) executionFailure('INTEGRITY'); return state.record; }
  const record = await context.codec.hydrate(state.body, state.recordDigest, check); check();
  if (canonical(executionMetadata(kind, record)) !== canonical(state.metadata)) executionFailure('INTEGRITY'); return record;
}
export async function prepareState(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', key: string, identity: RunIdentity,
  record: LogJsonValue, expectedRevision: number, type: string, check: () => void): Promise<PreparedState> {
  const revision = expectedRevision + 1; if (!Number.isSafeInteger(revision)) executionFailure('INTEGRITY');
  const metadata = executionMetadata(kind, record), requestId = `state:${randomUUID()}`;
  return (async () => {
    const encoded = await context.codec.encode(record, check); check();
    try {
      const recordDigest = encoded.digest;
      if (encoded.bytes.length <= 60000) {
        const recordJson = encoded.bytes.toString('utf8');
        try {
          const commit = captureLogCommit({ requestId, records: [{ identity, schema: { id: `oar.execution.${kind}`, version: 1 }, type,
            causal: [], payload: { inline: { kind, key, revision, recordJson, recordDigest, metadata } } }] });
          return { revision, record, recordJson, recordDigest, metadata, commit };
        } catch { /* Escaped inline bytes may require the artifact codec even for a small record. */ }
      }
      const body = await context.codec.stage(encoded.bytes, recordDigest, context.source.sourceId, identity, check); check();
      const commit = await context.binding.prepare({ requestId, records: [
        { identity, schema: { id: 'oar.execution.body', version: 1 }, type: `${kind}.body`, causal: [], payload: { artifact: body.reference } },
        { identity, schema: { id: `oar.execution.${kind}`, version: 2 }, type, causal: [], payload: { inline: { kind, key, revision, recordDigest, body: body as unknown as LogJsonValue, metadata: metadata as unknown as LogJsonValue } } },
      ] }); check();
      return { revision, record, recordJson: canonical(body), recordDigest, metadata, commit };
    } finally { encoded.bytes.fill(0); }
  })();
}
export function commitState(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', key: string, identity: RunIdentity, prepared: PreparedState): MaterializedState {
  const current = readState(context, kind, key, identity), { revision, recordJson, recordDigest, metadata } = prepared;
  if ((current?.revision ?? 0) !== revision - 1) executionFailure('OUTCOME_UNKNOWN');
  if (current?.recordDigest === recordDigest && current.recordJson === recordJson) return current;
  const receipt = context.binding.appendInTransaction(prepared.commit);
  context.db.prepare(`INSERT INTO main.oar_execution_states VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,state_key)
    DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,record_digest=excluded.record_digest,sequence=excluded.sequence,event_digest=excluded.event_digest,request_id=excluded.request_id`)
    .run(kind, key, canonical(identity), digest(canonical(identity)), revision, recordJson, recordDigest, receipt.head.sequence, receipt.head.digest,
      readEntry(context.db, receipt.head.sequence, context.source).requestId);
  return freeze({ revision, record: prepared.record, recordJson, recordDigest, metadata });
}
