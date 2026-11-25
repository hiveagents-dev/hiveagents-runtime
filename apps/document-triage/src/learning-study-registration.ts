import { learningDigest, DEFAULT_LEARNING_POLICY } from 'hiveagents-runtime/routing/learning';
import type { CurriculumIdentity } from './learning-curriculum.js';
import type { StudyEnvironment, StudyJournal } from './learning-study-types.js';
import { cellsFor, learningTask, assertPlanBounds, remainingCells } from './learning-study-plan.js';
import { trainingHistory, snapshot } from './learning-study-evidence.js';
export function assertEnvironmentBinding(environment: StudyEnvironment, state: StudyJournal, identity: CurriculumIdentity) {
  if (state.studyId !== environment.corpus.id || state.domain !== environment.domain || state.baseDigest !== identity.baseDigest
    || state.protocolDigest !== environment.protocolDigest || state.definitionDigest !== learningDigest(environment.definition)
    || state.timeoutMs !== environment.timeoutMs || learningDigest(state.limits) !== learningDigest(environment.corpus.study)
    || learningDigest(state.evaluation) !== learningDigest(environment.corpus.evaluation)
    || state.identity.baseDigest !== identity.baseDigest || learningDigest(state.identity.train) !== learningDigest(identity.train)
    || learningDigest(state.identity.fixed) !== learningDigest(identity.fixed)) throw new Error('Incompatible study source/domain/base/definition binding; use a separate state directory');
  if (state.identity.batches.length > identity.batches.length || state.identity.batches.some((batch,index) => learningDigest(batch) !== learningDigest(identity.batches[index]))) {
    throw new Error('Study batch registry must remain an unchanged prefix');
  }
}
async function rejectAppendCollisions(environment: StudyEnvironment, state: StudyJournal, identity: CurriculumIdentity) {
  const appended = identity.batches.slice(state.identity.batches.length).flatMap(batch => batch.tasks);
  if (!appended.length) return;
  const history = await trainingHistory(environment), pending = await environment.evidence.pending(environment.domain);
  const earlier = new Set([...state.production.map(p => p.inputDigest),...history.rows.map(row => row.observation.taskDigest),
    ...pending.filter(row => row.split === 'train').map(row => row.taskDigest)]);
  const earlierIds = new Set(state.production.map(p => p.id));
  if (appended.some(task => earlier.has(task.inputDigest) || earlierIds.has(task.id))) throw new Error('Appended batch collision with earlier production/training intent or evidence');
}
export async function registerEnvironment(environment: StudyEnvironment, identity: CurriculumIdentity, existing: StudyJournal|undefined, signal?: AbortSignal): Promise<StudyJournal> {
  if (existing) assertEnvironmentBinding(environment,existing,identity);
  const first = environment.corpus.train[0]!;
  const context = { runtime:environment.runtime,task:learningTask(first,identity.train[0]!.inputDigest),timeoutMs:environment.timeoutMs,...(signal === undefined ? {} : {signal}) };
  const binding = await environment.router.preflight(environment.definition,context);
  const configuredIds = typeof environment.definition.model === 'string' ? null : environment.definition.model.candidates.map(a => a.id);
  if (!binding.actions.length || configuredIds && (binding.actions.length !== configuredIds.length || configuredIds.some(id => !binding.actions.some(a => a.id === id)))
    || binding.candidates.some(candidate => candidate.status !== 'eligible')) throw new Error('All configured candidate arms must be eligible for study matrices');
  const shadow = await environment.router.shadow(environment.definition,context);
  if (binding.domain !== environment.domain || !shadow.binding || learningDigest(shadow.binding.actions) !== learningDigest(binding.actions)
    || shadow.binding.definitionDigest !== binding.definitionDigest) throw new Error('Incompatible study action binding');
  const expectedConfig = { ...DEFAULT_LEARNING_POLICY,objective:shadow.config.objective,minSimilarity:.5,alpha:.05 / environment.corpus.study.maxCycles };
  if (learningDigest(shadow.config) !== learningDigest(expectedConfig)) throw new Error('Study policy must retain default gates and alpha=.05/maxCycles');
  const pointer = await environment.router.inspect();
  for (const ref of [pointer.active,pointer.previous]) {
    const policy = await snapshot(environment,ref);
    if (policy && (!policy.binding || policy.binding.definitionDigest !== binding.definitionDigest
      || policy.binding.fallbackId !== binding.fallbackId || learningDigest(policy.binding.actions) !== learningDigest(binding.actions)
      || learningDigest(policy.config) !== learningDigest(shadow.config))) throw new Error('Incompatible active/previous policy lineage binding');
  }
  if (existing && (learningDigest(existing.binding) !== learningDigest(binding) || learningDigest(existing.config) !== learningDigest(shadow.config))) {
    throw new Error('Incompatible study action/execution identity or policy binding');
  }
  const state: StudyJournal = existing ?? { format:1,studyId:environment.corpus.id,domain:environment.domain,baseDigest:identity.baseDigest,
    protocolDigest:environment.protocolDigest,definitionDigest:learningDigest(environment.definition),timeoutMs:environment.timeoutMs,
    binding,config:shadow.config,limits:environment.corpus.study,evaluation:environment.corpus.evaluation,
    identity:{...identity,batches:[]},admittedAttempts:0,calibration:cellsFor(environment.corpus.id,identity.train,binding.actions,'train',1),cycles:[],production:[] };
  await rejectAppendCollisions(environment,state,identity);
  const appended = identity.batches.length > state.identity.batches.length;
  state.identity = identity;
  assertPlanBounds(state);
  if (appended && state.admittedAttempts + await remainingCells(state,environment) > state.limits.maxLaunches) throw new Error('Consumed admissions plus remaining registered plan exceed immutable study budget');
  return state;
}
