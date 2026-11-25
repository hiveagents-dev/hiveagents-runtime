import { hashTaskFeatures, inputDigest, learningDigest } from 'hiveagents-runtime/routing/learning';
import type { LearningPolicyBinding } from 'hiveagents-runtime/routing/learning';
import type { StudyTask } from './learning-curriculum.js';
import { learningTask } from './learning-study-plan.js';
import type { StudyEnvironment, StudyJournal } from './learning-study-types.js';

/** The SDK captures this exact scope before admission and checks its actual preparation before any durable start. */
export function expectedStudyBinding(state: StudyJournal, text: string): LearningPolicyBinding {
  const features = hashTaskFeatures(text);
  return { definitionDigest:state.binding.definitionDigest,actions:state.binding.actions,
    ...(state.binding.fallbackId === undefined ? {} : {fallbackId:state.binding.fallbackId}),
    features:{schema:features.schema,dimensions:features.values.length} };
}

/** Revalidate every configured arm before each external acquisition, including non-selected production arms. */
export async function assertCurrentStudyBinding(environment: StudyEnvironment, state: StudyJournal, task: StudyTask, signal: AbortSignal): Promise<void> {
  const prepared = await environment.router.preflight(environment.definition,{runtime:environment.runtime,
    task:learningTask(task,inputDigest(task.text)),timeoutMs:environment.timeoutMs,signal});
  if (prepared.domain !== state.domain || prepared.definitionDigest !== state.binding.definitionDigest
    || prepared.fallbackId !== state.binding.fallbackId || learningDigest(prepared.actions) !== learningDigest(state.binding.actions)
    || prepared.candidates.some(candidate => candidate.status !== 'eligible')) throw new Error('Current study action/execution binding changed before admission');
}
