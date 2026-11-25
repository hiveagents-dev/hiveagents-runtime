import { digest } from '../../shared/json.js';
import type { CapturedRun } from './run-context.js';
import { scopedPointer, type RouterState } from './router-state.js';
import type { LearningEpisode, LearningPreflight } from './types.js';
import { validateLearningRecord } from './validation.js';
export interface RunPlan {
    attemptId: string;
    observationId: string;
    episode?: LearningEpisode;
}
export async function assertEpisodeGeneration(state: RouterState, episode: LearningEpisode): Promise<void> {
    const comparison = episode.comparison;
    if (!comparison)
        return;
    const pointer = scopedPointer(await state.store.pointer(state.domain));
    if (pointer.generation !== comparison.expectedGeneration || pointer.active !== comparison.from
        || comparison.operation === 'rollback' && (pointer.generation < 1 || pointer.previous !== comparison.to))
        throw new Error('Prospective learning episode generation is stale');
}
/** Reject known ownership/cell errors before admission, probes or native work. */
export async function inspectRunPlan(state: RouterState, captured: CapturedRun): Promise<RunPlan> {
    let attemptId = captured.attemptId, observationId = captured.observationId;
    let episode: LearningEpisode | undefined;
    if (captured.split !== 'train') {
        const row = await state.store.get('episode', captured.episodeId!);
        if (!row)
            throw new Error('Prospective learning episode is missing');
        episode = validateLearningRecord('episode', row);
        const c = captured.selection;
        if (episode.domain !== state.domain || episode.kind !== captured.split || episode.definitionDigest !== c.definitionDigest || episode.protocolDigest !== state.protocolDigest)
            throw new TypeError('Prospective episode scope mismatch');
        if (episode.comparison && digest(episode.comparison.config) !== digest(state.policy))
            throw new TypeError('Prospective policy configuration mismatch');
        const action = episode.arms.find(a => a.id === c.evaluationArmId);
        const task = episode.tasks.find(t => t.taskDigest === c.taskDigest);
        if (!action || !task || digest(task.features) !== digest(c.features))
            throw new TypeError('Task or evaluation arm outside prospective episode');
        const cell = episode.cells.find(cell => cell.taskDigest === c.taskDigest && cell.actionKey === action.key && cell.repetition === captured.repetition);
        if (!cell || captured.attemptIdProvided && cell.attemptId !== attemptId || captured.observationIdProvided && cell.observationId !== observationId)
            throw new TypeError('Attempt or observation ID outside reserved matrix cell');
        attemptId = cell.attemptId;
        observationId = cell.observationId;
        await assertEpisodeGeneration(state, episode);
    }
    if (await state.store.get('attempt', attemptId))
        throw new Error('Duplicate durable learning attempt ID');
    if (await state.store.get('observation', observationId))
        throw new Error('Duplicate terminal learning observation ID');
    if (await state.store.get('decision', captured.selection.id))
        throw new Error('Duplicate learning decision ID');
    return { attemptId, observationId, ...(episode === undefined ? {} : { episode }) };
}
/** Full actual ready action universe is checked while reservation ownership is held. */
export async function validatePreparedPlan(state: RouterState, plan: RunPlan, preflight: LearningPreflight): Promise<void> {
    if (!plan.episode)
        return;
    const e = plan.episode;
    if (e.definitionDigest !== preflight.definitionDigest || e.fallbackId !== preflight.fallbackId || digest(e.arms) !== digest(preflight.actions))
        throw new TypeError('Prospective episode does not cover the full prepared action universe');
    await assertEpisodeGeneration(state, e);
}
