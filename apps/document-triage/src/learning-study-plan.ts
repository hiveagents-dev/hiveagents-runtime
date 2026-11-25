import { hashTaskFeatures, learningDigest, sealLearningRecord } from 'hiveagents-runtime/routing/learning';
import type { LearningAction, LearningEpisode, LearningPointer, LearningSnapshot } from 'hiveagents-runtime/routing/learning';
import type { CurriculumTaskIdentity, StudyTask } from './learning-curriculum.js';
import type { StudyCell, StudyCycle, StudyEnvironment, StudyJournal } from './learning-study-types.js';
export const stableId = (kind: string, value: unknown) => `study-${kind}-${learningDigest(value)}`;
export const learningTask = (task: StudyTask, inputDigest: string) => ({ id: task.id, version: '1', text: task.text, inputDigest });
export function cellsFor(study: string, tasks: readonly CurriculumTaskIdentity[], arms: readonly LearningAction[],
  split: StudyCell['split'], repetitions: number, episodeId?: string): StudyCell[] {
  return tasks.flatMap(task => arms.flatMap(arm => Array.from({ length: repetitions }, (_, repetition) => {
    const identity = { study, task: task.inputDigest, action: arm.key, split, repetition, episode: episodeId ?? null };
    return { taskId: task.id, taskDigest: task.inputDigest, actionKey: arm.key, armId: arm.id, split,
      attemptId: stableId('attempt', identity), observationId: stableId('observation', identity),
      ...(episodeId === undefined ? {} : { episodeId, repetition }) };
  })));
}
export function planCycle(state: StudyJournal, batchId: string, operation: StudyCycle['operation'], before: LearningPointer): StudyCycle {
  const batch = state.identity.batches.find(b => b.id === batchId)!;
  const id = stableId('cycle', { study: state.studyId, domain: state.domain, base: state.baseDigest, batch: batch.digest });
  const fixedId = stableId('fixed', id), freshId = stableId('fresh', id);
  return { id, batchId, batchDigest: batch.digest, gateId: stableId('gate', id), operation, before,
    cells: [...cellsFor(state.studyId, state.identity.fixed, state.binding.actions, 'fixed', state.evaluation.repetitions, fixedId),
      ...cellsFor(state.studyId, batch.tasks, state.binding.actions, 'fresh', state.evaluation.repetitions, freshId)], completed: false };
}
export function fullPlan(state: StudyJournal): StudyCell[] {
  return [...state.calibration, ...state.identity.batches.flatMap(batch => planCycle(state, batch.id, 'promote', { generation: 0, active: null, previous: null }).cells)];
}
export async function remainingCells(state: StudyJournal, environment: StudyEnvironment): Promise<number> {
  let remaining = 0;
  for (const cell of fullPlan(state)) {
    if (!await environment.evidence.get('observation', cell.observationId) && !await environment.evidence.get('attempt', cell.attemptId)) remaining++;
  }
  // Production intents recorded before acquisition also reserve room until an attempt starts.
  for (const intent of state.production) {
    if (!await environment.evidence.get('observation', intent.observationId) && !await environment.evidence.get('attempt', intent.attemptId)) remaining++;
  }
  return remaining;
}
export function assertPlanBounds(state: StudyJournal): void {
  const arms = state.binding.actions.length, reps = state.evaluation.repetitions;
  if (!arms || state.identity.train.length * arms > 4096 || state.identity.fixed.length * arms * reps > 4096
    || state.identity.batches.some(b => b.tasks.length * arms * reps > 4096)) throw new Error('Study Cartesian matrix exceeds 4096 cells');
  if (fullPlan(state).length > state.limits.maxLaunches) throw new Error('Whole registered study plan exceeds immutable maxLaunches budget');
}
export async function episodeFor(environment: StudyEnvironment, state: StudyJournal, cycle: StudyCycle,
  kind: 'fixed'|'fresh', challenger: LearningSnapshot|undefined): Promise<LearningEpisode> {
  const tasks = kind === 'fixed' ? environment.corpus.fixed : environment.corpus.freshBatches.find(b => b.id === cycle.batchId)!.tasks;
  const cells = cycle.cells.filter(c => c.split === kind);
  return sealLearningRecord('episode', { format: 1, id: cells[0]!.episodeId!, domain: state.domain, kind,
    createdAt: Date.now(), afterSequence: await environment.evidence.highWater(state.domain),
    definitionDigest: state.binding.definitionDigest, protocolDigest: state.protocolDigest, arms: state.binding.actions,
    ...(state.binding.fallbackId === undefined ? {} : { fallbackId: state.binding.fallbackId }),
    tasks: tasks.map(task => ({ taskDigest: cells.find(c => c.taskId === task.id)!.taskDigest, features: hashTaskFeatures(task.text) })),
    repetitions: state.evaluation.repetitions,
    cells: cells.map(c => ({ taskDigest: c.taskDigest, actionKey: c.actionKey, repetition: c.repetition!, attemptId: c.attemptId, observationId: c.observationId })),
    ...(kind === 'fresh' ? { comparison: { expectedGeneration: cycle.before.generation, from: cycle.before.active, to: cycle.challenger!,
      operation: cycle.operation, fixedEpisodeId: cycle.fixed!.id, config: challenger?.config ?? state.config, configDigest: learningDigest(challenger?.config ?? state.config) } } : {}) });
}
