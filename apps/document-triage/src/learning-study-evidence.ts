import { learningDigest, selectPolicy, validateLearningRecord } from 'hiveagents-runtime/routing/learning';
import type { LearningEpisode, LearningObservation, LearningSnapshot } from 'hiveagents-runtime/routing/learning';
import type { StudyCell, StudyCycle, StudyCycleReport, StudyEnvironment, StudyJournal } from './learning-study-types.js';
export async function trainingHistory(environment: StudyEnvironment, requestedThrough?: number) {
  const through = requestedThrough ?? await environment.evidence.highWater(environment.domain);
  const rows = await environment.evidence.observations(environment.domain, { split: 'train', limit: 10001, through });
  if (rows.length >= 10001) throw new Error('Cannot establish complete training history: 10001 row overflow');
  for (const row of rows) { validateLearningRecord('observation', row.observation); if (row.observation.domain !== environment.domain || row.observation.split !== 'train' || row.sequence > through) throw new Error('Invalid training history binding'); }
  return { hashes: [...new Set(rows.filter(r => r.observation.outcome === 'completed' && r.observation.quality.state === 'verified').map(r => r.observation.taskDigest))].sort(),
    through, rows };
}
export async function snapshot(environment: StudyEnvironment, ref: string|null): Promise<LearningSnapshot|undefined> {
  if (ref === null) return undefined;
  const value = await environment.evidence.get('snapshot',ref);
  if (!value || value.digest !== ref || value.domain !== environment.domain) throw new Error('Missing or incompatible frozen snapshot');
  return validateLearningRecord('snapshot',value);
}
export async function cellObservation(environment: StudyEnvironment, state: StudyJournal, cell: StudyCell): Promise<LearningObservation|undefined> {
  const value = await environment.evidence.get('observation',cell.observationId);
  const attempt = await environment.evidence.get('attempt',cell.attemptId);
  const action = state.binding.actions.find(a => a.key === cell.actionKey)!;
  const match = (row: NonNullable<typeof attempt>|LearningObservation) => row.domain === state.domain && row.taskDigest === cell.taskDigest
    && row.split === cell.split && row.episodeId === cell.episodeId && row.repetition === cell.repetition
    && learningDigest(row.action) === learningDigest(action);
  if (attempt) { validateLearningRecord('attempt',attempt); if (!match(attempt) || attempt.id !== cell.attemptId || attempt.observationId !== cell.observationId) throw new Error('Attempt does not match exact study plan'); }
  if (!value) return undefined;
  validateLearningRecord('observation',value);
  if (!attempt || !match(value) || value.id !== cell.observationId || value.attemptId !== cell.attemptId
    || value.decisionId !== attempt.decisionId || value.decisionDigest !== attempt.decisionDigest) throw new Error('Observation does not match exact study plan');
  const decision = await environment.evidence.get('decision',value.decisionId);
  if (!decision || decision.domain !== state.domain || decision.digest !== value.decisionDigest
    || decision.definitionDigest !== state.binding.definitionDigest || decision.taskDigest !== cell.taskDigest
    || learningDigest(decision.selected) !== learningDigest(action)) throw new Error('Observation decision binding mismatch');
  return value;
}
export async function publishEpisode(environment: StudyEnvironment, episode: LearningEpisode) {
  const existing = await environment.evidence.get('episode',episode.id);
  if (existing && learningDigest(existing) !== learningDigest(episode)) throw new Error('Persisted episode manifest differs from SDK evidence');
  if (!existing) await environment.evidence.put('episode',episode.id,episode);
}
function comparison(episode: LearningEpisode, rows: LearningObservation[], from: LearningSnapshot|undefined, to: LearningSnapshot|undefined) {
  const passRate = (policy: LearningSnapshot|undefined) => {
    const selected = episode.tasks.flatMap(task => {
      const action = selectPolicy(policy,episode.arms,task.features,episode.createdAt,episode.fallbackId);
      return rows.filter(row => row.taskDigest === task.taskDigest && row.action.key === action?.key);
    });
    return selected.length === episode.tasks.length * episode.repetitions && selected.every(row => row.quality.state === 'verified')
      ? selected.reduce((n,row) => n + Number(row.quality.state === 'verified' && row.quality.passed),0) / selected.length : null;
  };
  const fixedRates = episode.arms.map(action => {
    const selected = rows.filter(row => row.action.key === action.key);
    return selected.length === episode.tasks.length * episode.repetitions && selected.every(row => row.quality.state === 'verified')
      ? selected.reduce((n,row) => n + Number(row.quality.state === 'verified' && row.quality.passed),0) / selected.length : null;
  });
  const known = fixedRates.filter((n): n is number => n !== null);
  return { incumbentPassRate:passRate(from),learnedPassRate:passRate(to),bestFixedPassRate:known.length === episode.arms.length ? Math.max(...known) : null,candidateCoverage:known.length / episode.arms.length };
}
export async function cycleReport(environment: StudyEnvironment, state: StudyJournal, cycle: StudyCycle): Promise<StudyCycleReport> {
  const commit = await environment.evidence.get('gate-commit',cycle.gateId), gate = await environment.evidence.get('gate',cycle.gateId);
  if (!commit || !gate || !cycle.fixed || !cycle.fresh || cycle.challenger === undefined) throw new Error('Missing durable cycle gate/report evidence');
  validateLearningRecord('gate',gate); validateLearningRecord('gate-commit',commit);
  if (commit.gateDigest !== gate.digest || commit.domain !== state.domain || gate.domain !== state.domain
    || gate.from !== cycle.before.active || gate.to !== cycle.challenger || gate.expectedGeneration !== cycle.before.generation
    || gate.mode !== cycle.operation || gate.fixed.episodeDigest !== cycle.fixed.digest || gate.fresh.episodeDigest !== cycle.fresh.digest
    || gate.definitionDigest !== state.binding.definitionDigest || gate.configDigest !== learningDigest(state.config)) throw new Error('Cycle gate binding mismatch');
  for (const episode of [cycle.fixed,cycle.fresh]) {
    const stored = await environment.evidence.get('episode',episode.id);
    if (!stored || learningDigest(stored) !== learningDigest(episode)) throw new Error('Cycle report episode binding mismatch');
  }
  const rows: LearningObservation[] = [];
  for (const cell of cycle.cells) { const row = await cellObservation(environment,state,cell); if (!row) throw new Error('Incomplete cycle evidence'); rows.push(row); }
  const digestSets = [...gate.fixed.observationDigests,...gate.fresh.observationDigests].sort();
  if (learningDigest(digestSets) !== learningDigest(rows.map(row => row.digest).sort())) throw new Error('Gate observation evidence mismatch');
  return { id:cycle.id,batchId:cycle.batchId,batchDigest:cycle.batchDigest,domain:state.domain,from:cycle.before.active,challenger:cycle.challenger,
    gate,commit,pointer:commit.after,pointerAtCommit:commit.after,expectedCells:cycle.cells.length,terminalCells:rows.length,
    verifiedCells:rows.filter(row => row.quality.state === 'verified').length,observationDigests:rows.map(row => row.digest),
    comparison:comparison(cycle.fresh,rows.filter(row => row.split === 'fresh'),await snapshot(environment,cycle.before.active),await snapshot(environment,cycle.challenger)),
    fixedEpisodeId:cycle.fixed.id,freshEpisodeId:cycle.fresh.id,
    dataSources:{baseDigest:state.baseDigest,batchDigest:cycle.batchDigest,definitionDigest:state.binding.definitionDigest,protocolDigest:state.protocolDigest,
      actions:state.binding.actions,fixedEpisodeId:cycle.fixed.id,fixedEpisodeDigest:cycle.fixed.digest,freshEpisodeId:cycle.fresh.id,freshEpisodeDigest:cycle.fresh.digest} };
}
