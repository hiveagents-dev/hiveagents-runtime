import { createHash } from 'node:crypto';
import { canonical, freeze, hash, object } from '../../shared/json.js';
import { captureLogCommit } from './validation.js';
import { logError } from './store-types.js';
import type { LogEntry, LogSourceDescriptor } from './store-types.js';
import type { LogCommit, LogDraft } from './types.js';

export const MAX_EVENT_BYTES = 128 * 1024;
export function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function genesis(source: LogSourceDescriptor): string { return digest(`oar-neutral-log-v1\n${canonical(source)}`); }
export function capture(input: unknown, source: LogSourceDescriptor): LogCommit {
  try {
    const captured = captureLogCommit(input);
    for (const record of captured.records) if (record.identity.systemId !== source.systemId
      || 'artifact' in record.payload && record.payload.artifact.sourceId !== source.sourceId) logError('INVALID_INPUT');
    return captured;
  } catch { return logError('INVALID_INPUT'); }
}
export function entryBody(source: LogSourceDescriptor, sequence: number, requestId: string, ordinal: number, previousDigest: string, record: LogDraft) {
  return { format: 1 as const, sourceId: source.sourceId, sequence, requestId, ordinal, previousDigest, record };
}
export function decodeEntry(text: string, expectedDigest: unknown, source: LogSourceDescriptor): LogEntry {
  try {
    if (Buffer.byteLength(text) > MAX_EVENT_BYTES || digest(text) !== expectedDigest) logError('INTEGRITY');
    const body = JSON.parse(text); object(body, ['format', 'sourceId', 'sequence', 'requestId', 'ordinal', 'previousDigest', 'record']);
    if (Object.keys(body).length !== 7 || canonical(body) !== text || body.format !== 1 || body.sourceId !== source.sourceId
      || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1 || !Number.isSafeInteger(body.ordinal) || Number(body.ordinal) < 1 || Number(body.ordinal) > 256) logError('INTEGRITY');
    hash(body.previousDigest); const checked = capture({ requestId: body.requestId, records: [body.record] }, source);
    return freeze({ format: 1, sourceId: source.sourceId, sequence: Number(body.sequence), requestId: checked.requestId,
      ordinal: Number(body.ordinal), previousDigest: body.previousDigest, record: checked.records[0]!, digest: expectedDigest as string });
  } catch { return logError('INTEGRITY'); }
}
