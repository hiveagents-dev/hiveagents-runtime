import { freeze, hash, object } from '../../shared/json.js';
import { AGENT_METADATA_SCHEMA, CAPTURE_OPERATION_SCHEMA, boundedDataArray, boundedInteger, decodeCaptureMetadata } from './capture-codec.js';
import type { LogEntry } from './store-types.js';
import type { ProjectionIssue, ProjectionItem } from './projection-types.js';
import { digest } from './encoding.js';
import { captureExecutionMetadata } from './execution-metadata.js';
import { captureRecordBody } from './record-codec.js';
import { projectReconciliation } from './projection-reconciliation.js';
import { RUN_HISTORY_SCHEMA, decodeRunMarker } from './run-history-codec.js';
/** Closed public allowlist. Deliberately never parses the adjacent private recordJson. */
function executionMetadata(entry: LogEntry, input: unknown): Readonly<Record<string, unknown>> {
  object(input, entry.record.schema.version === 1 ? ['kind', 'key', 'revision', 'recordJson', 'recordDigest', 'metadata'] : ['kind', 'key', 'revision', 'recordDigest', 'body', 'metadata']);
  if (entry.record.schema.version === 1) { if (typeof input.recordJson !== 'string') throw Error(); }
  else { const body = captureRecordBody(input.body, entry.sourceId, entry.record.identity, 128 * 1024 * 1024); if (body.reference.digest !== input.recordDigest) throw Error(); }
  hash(input.key); hash(input.recordDigest); boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER);
  const kind = entry.record.schema.id === 'oar.execution.decision' ? 'decision' : 'workflow';
  if (input.kind !== kind) throw Error();
  const metadata = decodeExecutionMetadata(kind, input.metadata);
  if (entry.record.type !== `${kind}.${metadata.status}`) throw Error();
  return metadata;
}
export function decodeExecutionMetadata(kind: 'decision' | 'workflow', metadata: unknown): Readonly<Record<string, unknown>> {
  if (kind === 'workflow') { object(metadata); boundedDataArray(metadata.steps, 256); }
  return captureExecutionMetadata(kind, metadata) as unknown as Readonly<Record<string, unknown>>;
}
export function projectCommittedEntry(entry: LogEntry): ProjectionItem {
  const position = { sourceId: entry.sourceId, sequence: entry.sequence, digest: entry.digest }, issues: ProjectionIssue[] = [];
  const base = { id: `${entry.sourceId}:${entry.sequence}:${entry.digest}`, position, causal: entry.record.causal.map(ref => ({ sourceIdDigest: digest(ref.sourceId), sequence: ref.sequence, digest: ref.digest })) };
  if ('artifact' in entry.record.payload) return freeze({ ...base, category: 'unprojected', issues: ['PRIVATE_PAYLOAD'] });
  const schema = entry.record.schema;
  try {
    if (schema.id === RUN_HISTORY_SCHEMA && schema.version === 1) return freeze({ ...base, category: 'run', metadata: { stage: entry.record.type.slice(4), ...decodeRunMarker(entry.record.type, entry.record.payload.inline) }, issues });
    else if (schema.id === 'oar.execution.reconciliation' && schema.version === 1) return freeze({ ...base, category: 'reconciliation', metadata: projectReconciliation(entry, entry.record.payload.inline), issues });
    else if (['oar.execution.decision', 'oar.execution.workflow'].includes(schema.id) && [1, 2].includes(schema.version)) {
      if (schema.version === 2) issues.push('PRIVATE_PAYLOAD');
      return freeze({ ...base, category: schema.id === 'oar.execution.decision' ? 'decision' : 'workflow', metadata: executionMetadata(entry, entry.record.payload.inline), issues });
    } else if (schema.version !== 1) issues.push('UNKNOWN_SCHEMA');
    else if ([AGENT_METADATA_SCHEMA, CAPTURE_OPERATION_SCHEMA].includes(schema.id)) return freeze({ ...base, category: schema.id === AGENT_METADATA_SCHEMA ? 'agent-event' : 'capture-operation', metadata: decodeCaptureMetadata(schema.id, entry.record.type, entry.record.payload.inline), issues });
    else issues.push(['oar.execution.association', 'oar.execution.ownership'].includes(schema.id) ? 'PRIVATE_PAYLOAD' : 'UNKNOWN_SCHEMA');
  } catch { issues.push('INVALID_METADATA'); }
  return freeze({ ...base, category: 'unprojected', issues });
}
