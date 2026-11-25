import { pageRecords } from './paging.js';
import { executionFailure } from './execution-types.js';
import type { ExecutionDatabaseContext } from './execution-database.js';
import type { LogCursor } from './store-types.js';
import type { LogPosition } from './types.js';
/** A materialized row is only a view of the LAST matching transition in the verified chain.
 * Global 64-record pages validate before key exclusion. Total scan/SQL work grows with history. */
export function latestStatePosition(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', key: string): LogPosition | undefined {
  let cursor: LogCursor | undefined, latest: LogPosition | undefined;
  do {
    const page = pageRecords(context.db, context.source, context.storageDigest, cursor ? { cursor, limit: 64 } : { limit: 64 }); cursor = page.nextCursor;
    for (const entry of page.items) {
      if (entry.record.schema.id !== `oar.execution.${kind}`) continue;
      if (entry.record.schema.version !== 1 && entry.record.schema.version !== 2) executionFailure('INTEGRITY');
      const payload = 'inline' in entry.record.payload ? entry.record.payload.inline : undefined;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) executionFailure('INTEGRITY');
      if ((payload as Record<string, unknown>).kind === kind && (payload as Record<string, unknown>).key === key) latest = { sourceId: entry.sourceId, sequence: entry.sequence, digest: entry.digest };
    }
  } while (cursor);
  return latest;
}
