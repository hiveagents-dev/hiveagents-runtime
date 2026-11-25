import { digest } from '../../shared/json.js';
import { errorLabel } from './curation-support.js';
import type { StopReason } from './curation-support.js';
import { discordance, signTestPValue } from './curator-acceptance.js';
import type { CuratorPendingTally } from './curator-journal.js';
import { reserveMeasurement } from './curator-ledger.js';
import { CURATOR_SOURCE } from './curator-types.js';
import type {
  CuratorCandidateOutcome, CuratorMeasurement, CuratorPass, CuratorPooledEvidence, CuratorRefusal,
} from './curator-types.js';
import type { MemoryGateEvidence } from './gate.js';
import { measureMemory } from './measurement.js';
import type { MemoryMeasurementReport } from './measurement.js';
import type { MemoryRecordView } from './store-types.js';

/**
 * One measurement of a stored candidate and the decisions taken on it: single-stage acceptance,
 * the first stage of a confirmation, and the pooled second stage. No journal writes but the
 * measurement reservation; promotion is the caller's.
 */

export interface MeasuredCandidate {
  measurement: CuratorMeasurement;
  gate: MemoryGateEvidence;
  /** The store gate's verdict on this measurement alone. */
  gatePassed: boolean;
}

export interface PassControl {
  options: CuratorPass;
  signal: AbortSignal;
  stopped: () => StopReason | undefined;
  /** Measurements this pass reserved. */
  measurements: number;
}

export function stopLabel(state: Pick<PassControl, 'signal' | 'stopped'>): string | undefined {
  if (!state.signal.aborted) return undefined;
  return state.stopped() === 'deadline' ? 'DEADLINE' : 'ABORTED';
}

/** Reserves a measurement, then measures the stored candidate alone. An `error` outcome when it cannot. */
export async function measureStored(
  stored: MemoryRecordView, state: PassControl,
): Promise<MeasuredCandidate | Extract<CuratorCandidateOutcome, { status: 'error' }>> {
  const { options, signal } = state;
  const id = stored.record.id;
  try {
    await reserveMeasurement(options);
  } catch (error) {
    return { id, status: 'error', stage: 'journal', error: errorLabel(error) };
  }
  state.measurements += 1;
  const record = stored.record;
  let measured: MemoryMeasurementReport;
  try {
    measured = await measureMemory({
      id: `${CURATOR_SOURCE}-${id.slice(CURATOR_SOURCE.length + 1, CURATOR_SOURCE.length + 25)}`,
      tasks: options.measure.tasks,
      candidateDigests: [stored.contentDigest],
      recall: () => [record.text],
      history: options.measure.history,
      run: options.measure.run,
      signal,
    });
  } catch (error) {
    return { id, status: 'error', stage: 'measure', error: stopLabel(state) ?? errorLabel(error) };
  }
  // An errored run counts as a failed task: under no-memory it would look like a gain.
  if (measured.conditions['no-memory'].errors > 0 || measured.conditions.memory.errors > 0) {
    return { id, status: 'error', stage: 'measure', error: 'RUN_ERRORS' };
  }
  const discordant = discordance(measured);
  return {
    measurement: {
      id: measured.gate.measurementId, digest: measured.digest,
      noMemory: measured.gate.noMemory, memory: measured.gate.memory, fullHistory: measured.gate.fullHistory,
      discordant, pValue: signTestPValue(discordant.memoryOnly, discordant.noMemoryOnly),
    },
    gate: measured.gate,
    gatePassed: measured.verdict.passed,
  };
}

/**
 * The curator's acceptance over one body of evidence: the store gate (memory passed more tasks
 * than no memory), then the margin over the discordant tasks, then the sign test at `level`.
 */
export function refusalOf(
  evidence: { noMemory: { passed: number }; memory: { passed: number }; discordant: CuratorMeasurement['discordant']; pValue: number },
  options: CuratorPass, level: number,
): CuratorRefusal | undefined {
  if (!(evidence.memory.passed > evidence.noMemory.passed)) return 'NO_GAIN_OVER_NO_MEMORY';
  if (evidence.discordant.memoryOnly - evidence.discordant.noMemoryOnly < options.minMargin) return 'BELOW_MARGIN';
  if (evidence.pValue > level) return 'NOT_SIGNIFICANT';
  return undefined;
}

/** What a pending entry keeps of a first measurement. */
export function tallyOf(measured: MeasuredCandidate, contentDigest: string): CuratorPendingTally {
  const { measurement } = measured;
  return {
    digest: measurement.digest, contentDigest,
    noMemory: { ...measurement.noMemory }, memory: { ...measurement.memory }, fullHistory: { ...measurement.fullHistory },
    discordant: { ...measurement.discordant },
  };
}

/** Both measurements pooled: the gate evidence handed to the store, and what the report shows of it. */
export function pooledEvidence(
  first: CuratorPendingTally, second: MeasuredCandidate,
): { gate: MemoryGateEvidence; pooled: CuratorPooledEvidence; evidence: Parameters<typeof refusalOf>[0] } {
  const add = (a: { passed: number; total: number }, b: { passed: number; total: number }) =>
    ({ passed: a.passed + b.passed, total: a.total + b.total });
  const { measurement } = second;
  const noMemory = add(first.noMemory, measurement.noMemory);
  const memory = add(first.memory, measurement.memory);
  const fullHistory = add(first.fullHistory, measurement.fullHistory);
  const discordant = {
    memoryOnly: first.discordant.memoryOnly + measurement.discordant.memoryOnly,
    noMemoryOnly: first.discordant.noMemoryOnly + measurement.discordant.noMemoryOnly,
  };
  const pValue = signTestPValue(discordant.memoryOnly, discordant.noMemoryOnly);
  const digests: [string, string] = [first.digest, measurement.digest];
  const gate: MemoryGateEvidence = {
    measurementId: `${second.gate.measurementId}-pooled`,
    // The pooled evidence names both reports, so its numbers trace to them.
    digest: digest({ format: 1, pooled: digests, noMemory, memory, fullHistory }),
    candidateDigests: [...second.gate.candidateDigests],
    noMemory, memory, fullHistory,
  };
  return {
    gate,
    pooled: { measurements: 2, tasks: memory.total, discordant, pValue, digests },
    evidence: { noMemory, memory, discordant, pValue },
  };
}
