/**
 * The promotion gate: a measured comparison, supplied by the caller, between the
 * same task set run without memory, with memory, and with the full history.
 *
 * This file is pure (no Node imports) so a renderer can show a gate verdict.
 */

/** How many tasks of the shared task set passed under one condition. */
export interface MemoryConditionTally {
  passed: number;
  total: number;
}

/**
 * What a promotion must carry. Both controls are mandatory: a claim about memory
 * that was not measured against no-memory AND full-history is not evidence.
 */
export interface MemoryGateEvidence {
  /** Caller's id for the measurement that produced these numbers. */
  measurementId: string;
  /** SHA-256 of the measurement report, so the numbers can be traced to it. */
  digest: string;
  /**
   * Content digests (`MemoryRecordView.contentDigest`) of the records that were
   * in the memory condition. A digest binds scope, id and content, so evidence
   * for one record cannot promote another one that merely shares its id.
   */
  candidateDigests: readonly string[];
  noMemory: MemoryConditionTally;
  memory: MemoryConditionTally;
  fullHistory: MemoryConditionTally;
}

export type MemoryGateRefusal = 'NO_GAIN_OVER_NO_MEMORY' | 'CANDIDATE_NOT_MEASURED';

export type MemoryGateVerdict =
  | { passed: true }
  | { passed: false; reason: 'NO_GAIN_OVER_NO_MEMORY' };

const EVIDENCE_KEYS = ['measurementId', 'digest', 'candidateDigests', 'noMemory', 'memory', 'fullHistory'];
const SHA256 = /^[a-f0-9]{64}$/;
/** Control, format and line-separator characters: a label ends up in audit fields and on a console. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_CANDIDATES = 64;

function plainObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) {
    throw new TypeError(`${name} must have exactly: ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

function label(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || UNPRINTABLE.test(value)) {
    throw new TypeError(`${name} must be a nonempty printable string of at most 128 characters`);
  }
  return value;
}

function tally(value: unknown, name: string): MemoryConditionTally {
  const { passed, total } = plainObject(value, ['passed', 'total'], name);
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total)) {
    throw new TypeError(`${name} must hold integer counts`);
  }
  if ((total as number) < 1 || (passed as number) < 0 || (passed as number) > (total as number)) {
    throw new RangeError(`${name} must satisfy 0 <= passed <= total and total >= 1`);
  }
  return { passed: passed as number, total: total as number };
}

/** Throws unless the evidence is complete: three tallies over one nonempty task set. */
export function assertMemoryGateEvidence(value: unknown): MemoryGateEvidence {
  const evidence = plainObject(value, EVIDENCE_KEYS, 'gate evidence');
  const measurementId = label(evidence.measurementId, 'measurementId');
  if (typeof evidence.digest !== 'string' || !SHA256.test(evidence.digest)) {
    throw new TypeError('digest must be a SHA-256 hex digest');
  }
  const candidates = evidence.candidateDigests;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES
    || new Set(candidates).size !== candidates.length
    || candidates.some(candidate => typeof candidate !== 'string' || !SHA256.test(candidate))) {
    throw new TypeError(`candidateDigests must list 1 to ${MAX_CANDIDATES} distinct record content digests`);
  }
  const candidateDigests = [...candidates] as string[];
  const noMemory = tally(evidence.noMemory, 'noMemory');
  const memory = tally(evidence.memory, 'memory');
  const fullHistory = tally(evidence.fullHistory, 'fullHistory');
  if (noMemory.total !== memory.total || fullHistory.total !== memory.total) {
    throw new RangeError('The three conditions must have run the same task set');
  }
  return { measurementId, digest: evidence.digest, candidateDigests, noMemory, memory, fullHistory };
}

/**
 * The rule the store applies before a lesson becomes recallable: memory must pass
 * strictly more tasks than the no-memory control. Full history is the ceiling
 * reference; it must have been measured, but memory is not required to beat it,
 * because its point is to get close to that ceiling with far less context.
 *
 * Throws on incomplete evidence; a missing control is never a pass.
 */
export function evaluateMemoryGate(evidence: MemoryGateEvidence): MemoryGateVerdict {
  const checked = assertMemoryGateEvidence(evidence);
  if (checked.memory.passed > checked.noMemory.passed) return { passed: true };
  return { passed: false, reason: 'NO_GAIN_OVER_NO_MEMORY' };
}
