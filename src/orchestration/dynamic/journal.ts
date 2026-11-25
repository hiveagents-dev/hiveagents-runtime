/**
 * Dynamic workflows: the journal of finished agent calls.
 *
 * The engine journals only COMPLETED calls, keyed by call key; a resumed run replays them and re-runs
 * everything else. Two journals ship: `memoryDynamicJournal()` (one process, tests, short runs) and
 * `fileDynamicJournal(directory)` (journal-file.ts: JSONL per run, fsync'd, checksummed, one writer).
 *
 * `DynamicJournalLifecycle` is optional on any `DynamicJournal`: when present, the engine opens the run
 * before the script starts (so a locked or corrupt journal refuses the run up front) and closes it when
 * the run finishes, releasing the writer lock.
 */
import type { DynamicAgentResult } from './types.js';
import {
  DynamicJournalLockedError, validateDynamicAgentResult, validateDynamicRunId, type ManagedDynamicJournal,
} from './journal-records.js';

export {
  DynamicJournalCorruptError, DynamicJournalLockedError, DynamicJournalWriteError, validateDynamicAgentResult, validateDynamicRunId,
  type DynamicJournalLifecycle, type ManagedDynamicJournal,
} from './journal-records.js';

/**
 * In-process journal: records live in memory (lost with the process). `open`/`close` give the same
 * one-writer-per-run rule as the file journal, within this process.
 */
export function memoryDynamicJournal(): ManagedDynamicJournal {
  const runs = new Map<string, Map<string, DynamicAgentResult>>();
  const open = new Set<string>();
  const records = (runId: string) => {
    validateDynamicRunId(runId);
    let run = runs.get(runId);
    if (!run) { run = new Map(); runs.set(runId, run); }
    return run;
  };
  return {
    async open(runId) {
      validateDynamicRunId(runId);
      if (open.has(runId)) throw new DynamicJournalLockedError(runId);
      open.add(runId);
    },
    async close(runId) { open.delete(validateDynamicRunId(runId)); },
    async get(runId, key) {
      const record = records(runId).get(key);
      return record === undefined ? undefined : validateDynamicAgentResult(record);
    },
    async put(runId, result) {
      const record = validateDynamicAgentResult(result);
      records(runId).set(record.key, record);
    },
  };
}

export { fileDynamicJournal, type FileDynamicJournal, type DynamicJournalOwner } from './journal-file.js';
