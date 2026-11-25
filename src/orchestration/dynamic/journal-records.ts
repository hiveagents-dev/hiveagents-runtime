/**
 * Dynamic workflows: journal records, run ids, journal errors and the optional journal lifecycle.
 */
import type { DynamicAgentResult, DynamicJournal } from './types.js';
import { strictJson } from './limits.js';

/** Optional lifecycle the engine honours when a journal implements it. */
export interface DynamicJournalLifecycle {
  /** Claims the run for this writer and loads its records; rejects when another writer holds it or it is corrupt. */
  open?(runId: string): Promise<void>;
  /** Flushes pending writes and releases the run. */
  close?(runId: string): Promise<void>;
}

export type ManagedDynamicJournal = DynamicJournal & Required<DynamicJournalLifecycle>;

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const KEY = /^[A-Za-z0-9._:-]{1,256}$/;
const STATUSES = ['completed', 'failed', 'skipped'];

/** Thrown when another writer holds the run (inspect the lock; there is no automatic expiry). */
export class DynamicJournalLockedError extends Error {
  constructor(readonly runId: string, readonly lockPath?: string) {
    super(lockPath === undefined
      ? `Dynamic workflow run ${runId} is already open in this journal`
      : `Dynamic workflow run ${runId} is owned by another writer; inspect ${lockPath}`);
    this.name = 'DynamicJournalLockedError';
  }
}

/** Thrown when a journal line other than a torn last line fails its checksum or shape; the run is refused. */
export class DynamicJournalCorruptError extends Error {
  constructor(readonly runId: string, readonly line: number) {
    super(`Dynamic workflow journal for run ${runId} is corrupt at line ${line}`);
    this.name = 'DynamicJournalCorruptError';
  }
}

/**
 * Thrown by every `put` after an append failed and the journal could not cut the file back to its last
 * complete record: nothing more is written in this session. Close the run and open it again (the partial
 * tail is then dropped as a torn write).
 */
export class DynamicJournalWriteError extends Error {
  constructor(readonly runId: string) {
    super(`Dynamic workflow journal for run ${runId} could not undo a failed append; reopen the run to continue`);
    this.name = 'DynamicJournalWriteError';
  }
}

/** Run ids name journal files: `^[A-Za-z0-9._-]{1,128}$`, never `.` or `..`. */
export function validateDynamicRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || runId === '.' || runId === '..') {
    throw new TypeError('Run id must match ^[A-Za-z0-9._-]{1,128}$');
  }
  return runId;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Validates a result record's shape and returns a strict-JSON copy (throws TypeError otherwise). */
export function validateDynamicAgentResult(value: unknown): DynamicAgentResult {
  let copy: unknown;
  try { copy = strictJson(value); } catch { throw new TypeError('Agent result must be strict JSON'); }
  const fail = (field: string): never => { throw new TypeError(`Invalid agent result field ${field}`); };
  if (!plain(copy)) return fail('record');
  const allowed = ['key', 'label', 'status', 'output', 'usage', 'durationMs', 'worktree', 'error', 'cached'];
  for (const key of Object.keys(copy)) if (!allowed.includes(key)) fail(key);
  if (typeof copy.key !== 'string' || !KEY.test(copy.key)) fail('key');
  if (copy.label !== undefined && !boundedString(copy.label, 128)) fail('label');
  if (!STATUSES.includes(copy.status as string)) fail('status');
  if (!Object.hasOwn(copy, 'output')) fail('output');
  if (copy.usage !== undefined && (!plain(copy.usage) || typeof copy.usage.costMeaning !== 'string')) fail('usage');
  if (typeof copy.durationMs !== 'number' || copy.durationMs < 0) fail('durationMs');
  if (copy.worktree !== undefined) {
    const tree = copy.worktree;
    if (!plain(tree) || !boundedString(tree.path, 4096) || !boundedString(tree.branch, 1024) || typeof tree.changed !== 'boolean'
      || Object.keys(tree).length !== 3) fail('worktree');
  }
  if (copy.error !== undefined) {
    const error = copy.error;
    if (!plain(error) || !boundedString(error.code, 64) || !boundedString(error.message, 1024) || Object.keys(error).length !== 2) fail('error');
  }
  if (typeof copy.cached !== 'boolean') fail('cached');
  return copy as unknown as DynamicAgentResult;
}
