import { canonical, freeze, hash, object } from '../../shared/json.js';
import { AGENT_METADATA_SCHEMA, CAPTURE_OPERATION_SCHEMA, boundedDataArray, boundedInteger, decodeCaptureMetadata, invalidCapture } from './capture-codec.js';
import { genesis } from './encoding.js';
import { decodeExecutionMetadata } from './projection-codecs.js';
import { capturePublicReconciliation } from './projection-reconciliation.js';
import { capturePublicRunMarker } from './run-history-codec.js';
import type { LogSourceDescriptor } from './store-types.js';
import type { LogPosition } from './types.js';
import type { LogProjectionPage, ProjectionCursor, ProjectionIssue, ProjectionItem, ProjectionPurpose } from './projection-types.js';
export const sameProjectionData = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const issueCodes = ['UNKNOWN_SCHEMA', 'PRIVATE_PAYLOAD', 'INVALID_METADATA', 'UNRESOLVED_CAUSAL_REFERENCE', 'LOG_CORRUPT', 'SOURCE_UNAVAILABLE', 'PROJECTION_LIMIT', 'HISTORY_GAP', 'RUN_NOT_FOUND', 'INVOCATION_UNSETTLED', 'INCOMPLETE_ORIGIN'];
export const dataArray = boundedDataArray;
export function projectionPosition(input: unknown, source: LogSourceDescriptor): LogPosition {
  object(input, ['sourceId', 'sequence', 'digest']); if (input.sourceId !== source.sourceId) invalidCapture();
  boundedInteger(input.sequence, 0, Number.MAX_SAFE_INTEGER); hash(input.digest);
  if (input.sequence === 0 && input.digest !== genesis(source)) invalidCapture();
  return freeze({ sourceId: input.sourceId, sequence: input.sequence as number, digest: input.digest });
}
export function projectionSource(input: unknown): LogSourceDescriptor {
  object(input, ['format', 'sourceId', 'systemId']);
  if (input.format !== 1 || typeof input.sourceId !== 'string' || !input.sourceId || input.sourceId.length > 128 || typeof input.systemId !== 'string' || !input.systemId || input.systemId.length > 128) invalidCapture();
  return freeze({ format: 1, sourceId: input.sourceId, systemId: input.systemId });
}
export function projectionCursor(input: unknown, purpose: ProjectionPurpose, identityDigest: string, source: LogSourceDescriptor): ProjectionCursor {
  object(input, ['format', 'purpose', 'identityDigest', 'source', 'underlying']);
  if (input.format !== 1 || input.purpose !== purpose || input.identityDigest !== identityDigest || !sameProjectionData(projectionSource(input.source), source)) invalidCapture();
  object(input.underlying, ['format', 'filterDigest', 'after', 'through']); const raw = input.underlying;
  if (raw.format !== 1) invalidCapture(); hash(raw.filterDigest);
  const after = projectionPosition(raw.after, source), through = projectionPosition(raw.through, source); if (after.sequence > through.sequence) invalidCapture();
  return freeze({ format: 1, purpose, identityDigest, source, underlying: { format: 1, filterDigest: raw.filterDigest, after, through } });
}
function issues(input: unknown): readonly ProjectionIssue[] {
  const result = dataArray(input, issueCodes.length); if (new Set(result).size !== result.length || result.some(code => !issueCodes.includes(code as string))) invalidCapture(); return [...result] as ProjectionIssue[];
}
function item(input: unknown, source: LogSourceDescriptor): ProjectionItem {
  object(input, ['id', 'position', 'causal', 'category', 'metadata', 'issues']); const position = projectionPosition(input.position, source);
  if (!position.sequence || input.id !== `${source.sourceId}:${position.sequence}:${position.digest}`) invalidCapture();
  const causal = dataArray(input.causal, 64).map(ref => { object(ref, ['sourceIdDigest', 'sequence', 'digest']); hash(ref.sourceIdDigest); hash(ref.digest); boundedInteger(ref.sequence, 1, Number.MAX_SAFE_INTEGER); return { sourceIdDigest: ref.sourceIdDigest, sequence: ref.sequence as number, digest: ref.digest }; });
  const category = input.category as ProjectionItem['category']; let metadata: ProjectionItem['metadata'];
  if (category === 'agent-event') {
    object(input.metadata); object(input.metadata.event); const type = input.metadata.event.type; if (typeof type !== 'string') invalidCapture();
    metadata = decodeCaptureMetadata(AGENT_METADATA_SCHEMA, type, input.metadata);
  } else if (category === 'capture-operation') {
    object(input.metadata); metadata = decodeCaptureMetadata(CAPTURE_OPERATION_SCHEMA, `capture.${input.metadata.stage}`, input.metadata);
  } else if (category === 'decision' || category === 'workflow') metadata = decodeExecutionMetadata(category, input.metadata);
  else if (category === 'reconciliation') metadata = capturePublicReconciliation(input.metadata);
  else if (category === 'run') metadata = capturePublicRunMarker(input.metadata);
  else if (category !== 'unprojected' || input.metadata !== undefined) invalidCapture();
  return freeze({ id: input.id as string, position, causal, category, ...(metadata ? { metadata } : {}), issues: issues(input.issues) });
}
/** Restore only the closed public projection grammar. Restoration is DATA validation, not origin authentication. */
export function captureProjectionPage(input: unknown): LogProjectionPage {
  object(input, ['format', 'purpose', 'identityDigest', 'source', 'from', 'through', 'links', 'items', 'issues', 'nextCursor']);
  if (input.format !== 1 || !['trace', 'audit'].includes(input.purpose as string)) invalidCapture(); hash(input.identityDigest);
  const purpose = input.purpose as ProjectionPurpose, source = projectionSource(input.source), from = projectionPosition(input.from, source), through = projectionPosition(input.through, source);
  if (from.sequence > through.sequence) invalidCapture();
  const links = dataArray(input.links, 256).map(raw => { object(raw, ['position', 'previousDigest']); hash(raw.previousDigest); return { position: projectionPosition(raw.position, source), previousDigest: raw.previousDigest }; });
  let previous = from; for (const link of links) { if (link.position.sequence !== previous.sequence + 1 || link.previousDigest !== previous.digest || link.position.sequence > through.sequence) invalidCapture(); previous = link.position; }
  const items = dataArray(input.items, 256).map(raw => item(raw, source));
  const seen = new Set<number>(); for (const entry of items) { if (seen.has(entry.position.sequence) || !links.some(link => sameProjectionData(link.position, entry.position))) invalidCapture(); seen.add(entry.position.sequence); }
  const nextCursor = input.nextCursor === undefined ? undefined : projectionCursor(input.nextCursor, purpose, input.identityDigest, source);
  if (nextCursor && (!sameProjectionData(nextCursor.underlying.after, previous) || !sameProjectionData(nextCursor.underlying.through, through))) invalidCapture();
  const result = freeze({ format: 1 as const, purpose, identityDigest: input.identityDigest, source, from, through, links, items, issues: issues(input.issues), ...(nextCursor ? { nextCursor } : {}) });
  if (Buffer.byteLength(canonical(result)) > 4 * 1024 * 1024) invalidCapture(); return result;
}
