import { canonical, freeze } from '../../shared/json.js';
import type { ExecutionDatabaseContext } from './execution-database.js';
import { executionFailure } from './execution-types.js';
import { pageRecords } from './paging.js';
import { RUN_HISTORY_SCHEMA, decodeRunMarker } from './run-history-codec.js';
import type { RunHistoryRecord } from './run-history-types.js';
import type { LogCursor } from './store-types.js';
import type { RunIdentity } from './types.js';

/** Whole-source chain/index validation, bounded per invocation and under one SQLite snapshot. */
export function scanRuns(context: ExecutionDatabaseContext, maxEntries: number): { runs: Map<string, RunHistoryRecord>; scanned: number } {
  const runs = new Map<string, RunHistoryRecord>(); let cursor: LogCursor | undefined, scanned = 0;
  do {
    const page = pageRecords(context.db, context.source, context.storageDigest, { limit: Math.min(256, maxEntries - scanned + 1), ...(cursor ? { cursor } : {}) });
    scanned += page.scanned; if (scanned > maxEntries) executionFailure('CODEC_LIMIT'); cursor = page.nextCursor;
    for (const entry of page.items) {
      if (entry.record.schema.id !== RUN_HISTORY_SCHEMA) continue;
      try {
        if (entry.record.schema.version !== 1 || !('inline' in entry.record.payload)) executionFailure('INTEGRITY');
        const metadata = decodeRunMarker(entry.record.type, entry.record.payload.inline), identity = entry.record.identity;
        const position = { sourceId: entry.sourceId, sequence: entry.sequence, digest: entry.digest }, prior = runs.get(identity.runId);
        if (entry.record.type === 'run.started') {
          if (prior || entry.record.causal.length) executionFailure('INTEGRITY');
          runs.set(identity.runId, freeze({ schemaVersion: 1, sourceId: entry.sourceId, identity, inputDigest: metadata.inputDigest, status: 'unknown', started: position }));
        } else {
          if (!prior || prior.status !== 'unknown' || canonical(prior.identity) !== canonical(identity) || prior.inputDigest !== metadata.inputDigest
            || canonical(entry.record.causal) !== canonical([prior.started])) executionFailure('INTEGRITY');
          runs.set(identity.runId, freeze({ ...prior, status: entry.record.type === 'run.completed' ? 'completed' : 'interrupted', terminal: position,
            ...(metadata.outputDigest === undefined ? {} : { outputDigest: metadata.outputDigest }), ...(metadata.reason === undefined ? {} : { reason: metadata.reason }) }));
        }
      } catch { executionFailure('INTEGRITY'); }
    }
  } while (cursor);
  return { runs, scanned };
}
export function matchingRun(runs: Map<string, RunHistoryRecord>, identity: RunIdentity): RunHistoryRecord | undefined {
  const record = runs.get(identity.runId);
  if (record && canonical(record.identity) !== canonical(identity)) executionFailure('INVALID_STATE');
  return record;
}
