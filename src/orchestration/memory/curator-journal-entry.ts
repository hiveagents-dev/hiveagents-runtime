/**
 * The curator journal's entries and their validation: journals hold untrusted data, so every
 * entry read or written is checked here (JOURNAL_INVALID otherwise).
 */

/** The counts of a pending candidate's first measurement: no text. */
export interface CuratorPendingTally {
  /** Digest of the first measurement report. */
  digest: string;
  /** Content digest of the record measured: a confirmation of another content is not pooled with it. */
  contentDigest: string;
  noMemory: { passed: number; total: number };
  memory: { passed: number; total: number };
  fullHistory: { passed: number; total: number };
  discordant: { memoryOnly: number; noMemoryOnly: number };
}

export interface CuratorJournalEntry {
  /** Last decision for this key. */
  outcome: 'refused' | 'promoted' | 'rolled-back' | 'pending';
  /** ISO time it was recorded. */
  at: string;
  /** Candidate keys: the refusal code. */
  reason?: string;
  /** Episode keys: ids of the promoted candidates that cite this episode. */
  promoted?: string[];
  /** Episode keys: those of `promoted` found withdrawn (rolled back or revoked) since. */
  rolledBack?: string[];
  /** Episode keys: the episode is not offered to `distill` before this ISO time. */
  cooldownUntil?: string;
  /** Budget keys: ISO times of the scope's promotions (reserved before the store is asked) less than a day old, later ones included. */
  promotedAt?: string[];
  /** Measurement budget keys: ISO times of the scope's measurements (reserved before each runs) less than a day old. */
  measuredAt?: string[];
  /** Candidate keys: the sketch of the candidate's text, so a withdrawal can cool down its paraphrases. */
  sketch?: string;
  /** Pending candidate keys: the first measurement. */
  tally?: CuratorPendingTally;
  /** Pending candidate keys: refused as CONFIRMATION_EXPIRED when not confirmed by this ISO time. */
  pendingUntil?: string;
  /** Pending index keys: ids of the scope's pending candidates, oldest first. */
  pending?: string[];
  /** Rejection index keys: sketches of recently refused or withdrawn candidates, and when each stops holding paraphrases back. */
  rejected?: { until: string; sketch: string }[];
}

const MAX_IDS = 16;
const OUTCOMES = new Set(['refused', 'promoted', 'rolled-back', 'pending']);
const MAX_TIMES = 64;
/** Rejections a scope's index keeps. */
export const MAX_REJECTED = 64;
const ENTRY_KEYS = new Set([
  'outcome', 'at', 'reason', 'promoted', 'rolledBack', 'cooldownUntil', 'promotedAt',
  'measuredAt', 'sketch', 'tally', 'pendingUntil', 'pending', 'rejected',
]);
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Up to 64 hashes of 8 hex characters, ascending: see `curator-similarity.ts`. */
const SKETCH = /^(?:[0-9a-f]{8}){0,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TALLY_KEYS = ['digest', 'contentDigest', 'noMemory', 'memory', 'fullHistory', 'discordant'];


export function corrupt(): Error {
  return Object.assign(new Error('The curator journal holds an invalid entry'), { name: 'CuratorJournalError', code: 'JOURNAL_INVALID' });
}

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !UNPRINTABLE.test(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS || !value.every(isKey)) throw corrupt();
  return [...value];
}

function times(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TIMES || !value.every(isTime)) throw corrupt();
  return [...value];
}

function sketchOf(value: unknown): string {
  if (typeof value !== 'string' || !SKETCH.test(value)) throw corrupt();
  return value;
}

/** The most tasks one measurement takes (`measureMemory`): no count of a tally exceeds it. */
export const MAX_MEASURED_TASKS = 1024;
/** The longest a candidate may stay pending (`confirmWithinMs` is at most this). */
export const MAX_CONFIRM_WITHIN_MS = 30 * 24 * 60 * 60_000;

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_MEASURED_TASKS) throw corrupt();
  return value as number;
}

function pair<K extends string>(value: unknown, keys: readonly [K, K]): Record<K, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || !keys.every(key => Object.hasOwn(source, key))) throw corrupt();
  return { [keys[0]]: count(source[keys[0]]), [keys[1]]: count(source[keys[1]]) } as Record<K, number>;
}

function tallyOf(value: unknown): CuratorPendingTally {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== TALLY_KEYS.length || !TALLY_KEYS.every(key => Object.hasOwn(source, key))) throw corrupt();
  if (typeof source.digest !== 'string' || !SHA256.test(source.digest)) throw corrupt();
  if (typeof source.contentDigest !== 'string' || !SHA256.test(source.contentDigest)) throw corrupt();
  const tally = (raw: unknown) => {
    const checked = pair(raw, ['passed', 'total']);
    if (checked.passed > checked.total || checked.total < 1) throw corrupt();
    return checked;
  };
  const checked: CuratorPendingTally = {
    digest: source.digest, contentDigest: source.contentDigest,
    noMemory: tally(source.noMemory), memory: tally(source.memory), fullHistory: tally(source.fullHistory),
    discordant: pair(source.discordant, ['memoryOnly', 'noMemoryOnly']),
  };
  // One measurement runs every task under all three conditions, and the counts must be those of
  // one set of paired outcomes: tasks both passed = memory passed - memoryOnly = no memory passed - noMemoryOnly.
  const { noMemory, memory, fullHistory, discordant } = checked;
  const both = memory.passed - discordant.memoryOnly;
  if (noMemory.total !== memory.total || fullHistory.total !== memory.total || both < 0
    || noMemory.passed - discordant.noMemoryOnly !== both
    || both + discordant.memoryOnly + discordant.noMemoryOnly > memory.total) throw corrupt();
  return checked;
}

function rejectedOf(value: unknown): { until: string; sketch: string }[] {
  if (!Array.isArray(value) || value.length > MAX_REJECTED) throw corrupt();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw corrupt();
    const { until, sketch, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || !isTime(until)) throw corrupt();
    return { until, sketch: sketchOf(sketch) };
  });
}

/** A checked copy of an entry; throws JOURNAL_INVALID on anything else. Journals hold untrusted data. */
export function journalEntry(value: unknown): CuratorJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !ENTRY_KEYS.has(key))) throw corrupt();
  if (!OUTCOMES.has(source.outcome as string) || !isTime(source.at)) throw corrupt();
  const entry: CuratorJournalEntry = { outcome: source.outcome as CuratorJournalEntry['outcome'], at: source.at };
  if (source.reason !== undefined) {
    if (typeof source.reason !== 'string' || !CODE.test(source.reason)) throw corrupt();
    entry.reason = source.reason;
  }
  if (source.promoted !== undefined) entry.promoted = ids(source.promoted);
  if (source.rolledBack !== undefined) entry.rolledBack = ids(source.rolledBack);
  if (source.cooldownUntil !== undefined) {
    if (!isTime(source.cooldownUntil)) throw corrupt();
    entry.cooldownUntil = source.cooldownUntil;
  }
  if (source.promotedAt !== undefined) entry.promotedAt = times(source.promotedAt);
  if (source.measuredAt !== undefined) entry.measuredAt = times(source.measuredAt);
  if (source.sketch !== undefined) entry.sketch = sketchOf(source.sketch);
  if (source.tally !== undefined) entry.tally = tallyOf(source.tally);
  if (source.pendingUntil !== undefined) {
    // A pending candidate waits at most MAX_CONFIRM_WITHIN_MS from when it was journaled.
    if (!isTime(source.pendingUntil) || Date.parse(source.pendingUntil) - Date.parse(entry.at) > MAX_CONFIRM_WITHIN_MS) throw corrupt();
    entry.pendingUntil = source.pendingUntil;
  }
  if (source.pending !== undefined) entry.pending = ids(source.pending);
  if (source.rejected !== undefined) entry.rejected = rejectedOf(source.rejected);
  return entry;
}
