import type { DatabaseSync } from 'node:sqlite';
import { canonical, freeze, hash, identifier, object, ownObject } from '../../shared/json.js';
import { digest, genesis } from './encoding.js';
import { readEntry, readHead } from './records.js';
import { logError } from './store-types.js';
import type { LogCursor, LogPage, LogQuery, LogSourceDescriptor } from './store-types.js';
import type { LogPosition } from './types.js';

export function captureQuery(input: LogQuery = {}): LogQuery {
  try {
    input = ownObject(input, ['generation', 'runId', 'agentId', 'limit', 'cursor']);
    const output: Record<string, unknown> = {};
    for (const key of ['runId', 'agentId'] as const) if (input[key] !== undefined) { identifier(input[key]); output[key] = input[key]; }
    if (input.generation !== undefined) { if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 1) logError('INVALID_INPUT'); output.generation = input.generation; }
    const limit = input.limit ?? 64;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 256) logError('INVALID_INPUT'); output.limit = limit;
    if (input.cursor !== undefined) {
      const cursor = input.cursor; object(cursor, ['format', 'filterDigest', 'after', 'through']);
      if (Object.keys(cursor).length !== 4 || cursor.format !== 1) logError('INVALID_INPUT'); hash(cursor.filterDigest);
      const positions = [cursor.after, cursor.through].map(value => {
        object(value, ['sourceId', 'sequence', 'digest']); identifier(value.sourceId); hash(value.digest);
        if (Object.keys(value).length !== 3 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) logError('INVALID_INPUT');
        return { sourceId: value.sourceId, sequence: value.sequence, digest: value.digest };
      });
      output.cursor = { format: 1, filterDigest: cursor.filterDigest, after: positions[0], through: positions[1] };
    }
    return freeze(output) as LogQuery;
  } catch { return logError('INVALID_INPUT'); }
}
export function pageRecords(db: DatabaseSync, source: LogSourceDescriptor, storageDigest: string, query: LogQuery): LogPage {
  const { cursor, limit = 64, ...filter } = query;
  const filterDigest = digest(canonical({ purpose: 'oar-log-page-v1', source, storageDigest, filter }));
  const head = readHead(db, source), through = cursor?.through ?? head;
  const after: LogPosition = cursor?.after ?? { sourceId: source.sourceId, sequence: 0, digest: genesis(source) };
  if (cursor && cursor.filterDigest !== filterDigest || through.sourceId !== source.sourceId || after.sourceId !== source.sourceId
    || after.sequence > through.sequence || through.sequence > head.sequence) logError('INVALID_INPUT');
  for (const position of [after, through]) {
    const known = position.sequence === 0 ? genesis(source) : db.prepare('SELECT digest FROM main.oar_log_events WHERE sequence=?').get(position.sequence)?.digest;
    if (known !== position.digest) logError('INTEGRITY');
  }
  const ids = db.prepare('SELECT sequence FROM main.oar_log_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(after.sequence, through.sequence, limit + 1);
  const items = []; let previous = after.digest, last = after;
  const scanned = Math.min(ids.length, limit);
  for (let index = 0; index < scanned; index++) {
    const entry = readEntry(db, Number(ids[index]!.sequence), source);
    if (entry.sequence !== after.sequence + index + 1 || entry.previousDigest !== previous) logError('INTEGRITY');
    previous = entry.digest; last = { sourceId: source.sourceId, sequence: entry.sequence, digest: entry.digest };
    // Decode/hash/index validation always precedes filtering, including nonmatching rows.
    const identity = entry.record.identity;
    if ((filter.generation === undefined || identity.generation === filter.generation)
      && (filter.runId === undefined || identity.runId === filter.runId) && (filter.agentId === undefined || identity.agentId === filter.agentId)) items.push(entry);
  }
  const nextCursor: LogCursor | undefined = ids.length > limit ? { format: 1, filterDigest, after: last, through } : undefined;
  return freeze({ source, through, items, scanned, ...(nextCursor ? { nextCursor } : {}) });
}
