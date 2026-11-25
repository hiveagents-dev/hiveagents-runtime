import { canonical, freeze, hash, identifier, ownObject } from '../../shared/json.js';
import { executionContext } from './execution-database.js';
import { executionFailure } from './execution-types.js';
import { captureIdentity } from './reconstruction.js';
import { RUN_HISTORY_SCHEMA } from './run-history-codec.js';
import { matchingRun, scanRuns } from './run-history-storage.js';
import type { RunHistory, RunHistoryComplete, RunHistoryHandle, RunHistoryInterrupt, RunHistoryOptions, RunHistoryRecord } from './run-history-types.js';
import type { RunIdentity } from './types.js';

function input<T>(value: T, keys: readonly string[]): T {
  try { return ownObject(value, keys); } catch { return executionFailure('INVALID_STATE'); }
}
function id(value: unknown): void { try { identifier(value); } catch { executionFailure('INVALID_STATE'); } }
function sha(value: unknown): void { try { hash(value); } catch { executionFailure('INVALID_STATE'); } }
/** Lifecycle and deduplication DATA in the existing log. Does not execute work or prove its postconditions. */
export function createRunHistory(options: RunHistoryOptions): RunHistory {
  options = input(options, ['database', 'maxEntries']);
  const context = executionContext(options.database), maxEntries = options.maxEntries ?? 4096;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 65536) executionFailure('INVALID_STATE');
  const handles = new WeakMap<object, RunHistoryRecord>();
  const identity = (value: RunIdentity) => {
    let captured: RunIdentity; try { captured = captureIdentity(value); } catch { return executionFailure('INVALID_STATE'); }
    if (captured.systemId !== context.source.systemId) executionFailure('INVALID_STATE'); return captured;
  };
  const finish = async (handle: RunHistoryHandle, raw: RunHistoryComplete | RunHistoryInterrupt, status: 'completed' | 'interrupted'): Promise<RunHistoryRecord> => {
    const saved = handle && typeof handle === 'object' ? handles.get(handle) : undefined; if (!saved) executionFailure('INVALID_STATE');
    const command = input(raw, status === 'completed' ? ['requestId', 'outputDigest'] : ['requestId', 'reason']); id(command.requestId);
    const outputDigest = 'outputDigest' in command ? command.outputDigest : undefined, reason = 'reason' in command ? command.reason : undefined;
    if (outputDigest !== undefined) sha(outputDigest);
    if (status === 'interrupted' && (typeof reason !== 'string' || !['aborted', 'failed', 'stopped', 'halted'].includes(reason))) executionFailure('INVALID_STATE');
    return context.transaction(() => {
      const { runs, scanned } = scanRuns(context, maxEntries);
      const prior = matchingRun(runs, saved.identity);
      if (!prior || canonical(prior.started) !== canonical(saved.started) || prior.inputDigest !== saved.inputDigest) executionFailure('INTEGRITY');
      if (prior.status !== 'unknown') {
        if (prior.status !== status || prior.outputDigest !== outputDigest || prior.reason !== reason) executionFailure('INVALID_STATE'); return prior;
      }
      if (scanned >= maxEntries) executionFailure('CODEC_LIMIT');
      const receipt = context.binding.appendInTransaction({ requestId: command.requestId, records: [{ identity: saved.identity, schema: { id: RUN_HISTORY_SCHEMA, version: 1 },
        type: `run.${status}`, causal: [prior.started], payload: { inline: { inputDigest: prior.inputDigest, ...(outputDigest === undefined ? {} : { outputDigest }), ...(reason === undefined ? {} : { reason }) } } }] });
      return freeze({ ...prior, status, terminal: receipt.first, ...(outputDigest === undefined ? {} : { outputDigest }), ...(reason === undefined ? {} : { reason }) });
    }, true);
  };
  return Object.freeze({
    async begin(raw) {
      const command = input(raw, ['identity', 'requestId', 'inputDigest']), captured = identity(command.identity); id(command.requestId); sha(command.inputDigest);
      const result = context.transaction(() => {
        const { runs, scanned } = scanRuns(context, maxEntries);
        const prior = matchingRun(runs, captured);
        if (prior) { if (prior.inputDigest !== command.inputDigest) executionFailure('INVALID_STATE'); return { kind: 'existing' as const, record: prior }; }
        let reserved = 2; // The new start and its terminal record.
        for (const run of runs.values()) if (run.status === 'unknown') reserved++;
        if (scanned + reserved > maxEntries) executionFailure('CODEC_LIMIT');
        const receipt = context.binding.appendInTransaction({ requestId: command.requestId, records: [{ identity: captured, schema: { id: RUN_HISTORY_SCHEMA, version: 1 }, type: 'run.started', causal: [], payload: { inline: { inputDigest: command.inputDigest } } }] });
        return { kind: 'started' as const, record: freeze({ schemaVersion: 1 as const, sourceId: context.source.sourceId, identity: captured, inputDigest: command.inputDigest, status: 'unknown' as const, started: receipt.first }) };
      }, true);
      // Never mint an execution handle before actual COMMIT acknowledgement.
      if (result.kind === 'existing') return Object.freeze(result);
      const run = Object.freeze({}) as RunHistoryHandle; handles.set(run, result.record); return Object.freeze({ ...result, run });
    },
    complete: (handle, command) => finish(handle, command, 'completed'),
    interrupt: (handle, command) => finish(handle, command, 'interrupted'),
    async recover(raw) { const captured = identity(raw); return context.transaction(() => matchingRun(scanRuns(context, maxEntries).runs, captured)); },
    async list(raw = {}) {
      const command = input(raw, ['generation', 'limit']), limit = command.limit ?? 64;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || command.generation !== undefined && (!Number.isSafeInteger(command.generation) || command.generation < 1)) executionFailure('INVALID_STATE');
      return context.transaction(() => freeze([...scanRuns(context, maxEntries).runs.values()].filter(record => command.generation === undefined || record.identity.generation === command.generation).sort((a, b) => b.started.sequence - a.started.sequence).slice(0, limit)));
    },
  } satisfies RunHistory);
}
