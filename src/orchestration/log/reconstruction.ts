import { setImmediate } from 'node:timers/promises';
import { canonical, freeze } from '../../shared/json.js';
import { captureLogCommit } from './validation.js';
import { verifyReference } from './configuration.js';
import type { Configuration } from './configuration.js';
import { isLogStoreError, logError } from './store-types.js';
import type { LogCursor, LogPage, LogQuery, LogSourceDescriptor, ReconstructionIssue, RunReconstruction } from './store-types.js';
import type { LogPosition, RunIdentity } from './types.js';

export function captureIdentity(input: RunIdentity): RunIdentity {
  try { return captureLogCommit({ requestId: 'inspect', records: [{ identity: input, schema: { id: 'inspect', version: 1 }, type: 'inspect', causal: [], payload: { inline: null } }] }).records[0]!.identity; }
  catch { return logError('INVALID_INPUT'); }
}
/** No reducer or effect dispatcher: this reports captured-history coverage at one source head. */
export async function reconstruct(identity: RunIdentity, source: LogSourceDescriptor, config: Configuration,
  page: (query: LogQuery) => LogPage, causal: (position: LogPosition) => boolean, signal?: AbortSignal): Promise<RunReconstruction> {
  const issues = new Set<ReconstructionIssue>(); let count = 0, through: LogPosition | undefined, cursor: LogCursor | undefined;
  try {
    do {
      const batch = page(cursor ? { cursor } : {}); through = batch.through; cursor = batch.nextCursor;
      for (const entry of batch.items) {
        if (canonical(entry.record.identity) !== canonical(identity)) continue;
        count++;
        if (!config.schemas.has(canonical(entry.record.schema))) issues.add('UNKNOWN_SCHEMA');
        for (const ref of entry.record.causal) if (ref.sourceId !== source.sourceId || ref.sequence >= entry.sequence || !causal(ref)) issues.add('UNRESOLVED_CAUSAL_REFERENCE');
        if ('artifact' in entry.record.payload) {
          const result = await verifyReference(config.verify, entry.record.payload.artifact, source, signal);
          if (result !== 'verified') issues.add(result === 'missing' ? 'PAYLOAD_MISSING' : result === 'corrupt' ? 'PAYLOAD_CORRUPT' : 'PAYLOAD_UNVERIFIED');
        }
      }
      if (cursor) await setImmediate();
    } while (cursor);
    if (!count) issues.add('RUN_NOT_FOUND');
    return freeze({ scope: 'captured-history', kind: issues.size ? 'incomplete' : 'complete', identity, ...(through ? { through } : {}), eventCount: count, issues: [...issues].sort() });
  } catch (error) {
    if (!isLogStoreError(error) || error.code !== 'INTEGRITY') throw error;
    return freeze({ scope: 'captured-history', kind: 'corrupt', identity, ...(through ? { through } : {}), eventCount: count, issues: ['LOG_CORRUPT'] });
  }
}
