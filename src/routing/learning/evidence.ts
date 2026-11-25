import { digest, jsonClone, ownObject } from '../../shared/json.js';
import type { LearningAssessment, LearningEpisode, LearningGate, LearningObservation, LearningPairedTask, LearningSnapshot, SequencedObservation } from './types.js';
import { selectPolicy } from './estimator.js';
import { sealLearningRecord, validateLearningRecord } from './validation.js';
export interface GateEvidenceInput {
    id: string;
    createdAt: number;
    domain: string;
    fresh: LearningEpisode;
    fixed: LearningEpisode;
    fromSnapshot?: LearningSnapshot;
    toSnapshot?: LearningSnapshot;
    observations: readonly SequencedObservation[];
}
function empty(e: LearningEpisode, rows: readonly SequencedObservation[] = []): LearningAssessment { const lookup = new Map(rows.map(r => [r.observation.id, r.observation.digest])); return { episodeId: e.id, episodeDigest: e.digest, observationDigests: e.cells.flatMap(c => lookup.has(c.observationId) ? [lookup.get(c.observationId)!] : []), expectedCells: e.cells.length, verifiedCells: 0, tasks: [], wins: 0, losses: 0, ties: 0 }; }
/** One-sided exact sign test on distinct executable tasks. Ties do not vote. */
function signP(wins: number, losses: number): number {
    const n = wins + losses;
    if (!n)
        return 1;
    if (n > 10000)
        return 1;
    let logTerm = 0, sum = 0;
    for (let k = 0; k <= n; k++) {
        if (k >= wins)
            sum += Math.exp(logTerm - n * Math.LN2);
        if (k < n)
            logTerm += Math.log(n - k) - Math.log(k + 1);
    }
    return Math.min(1, sum);
}
function mean(xs: readonly number[]): number { return xs.reduce((n, x) => n + x, 0) / xs.length; }
interface AssessmentResult {
    assessment: LearningAssessment;
    incomplete: boolean;
    regression: boolean;
    unknown: boolean;
}
function assess(e: LearningEpisode, rows: readonly SequencedObservation[], input: GateEvidenceInput, selections: Map<string, {
    from?: string;
    to?: string;
}>): AssessmentResult {
    const result = empty(e), lookup = new Map(rows.map(r => [r.observation.id, r]));
    let incomplete = false, regression = false, unknown = false;
    const byTaskAction = new Map<string, LearningObservation[]>();
    const digests: string[] = [];
    for (const cell of e.cells) {
        const row = lookup.get(cell.observationId), o = row?.observation;
        if (o)
            digests.push(o.digest);
        if (!o || !row || row.sequence <= e.afterSequence || o.domain !== e.domain || o.split !== e.kind || o.episodeId !== e.id || o.attemptId !== cell.attemptId || o.taskDigest !== cell.taskDigest || o.action.key !== cell.actionKey || o.repetition !== cell.repetition || o.quality.state !== 'verified' || o.outcome !== 'completed' || digest(o.action) !== digest(e.arms.find(a => a.key === cell.actionKey)) || digest(o.features) !== digest(e.tasks.find(t => t.taskDigest === cell.taskDigest)!.features)) {
            incomplete = true;
            continue;
        }
        result.verifiedCells++;
        const key = `${cell.taskDigest}:${cell.actionKey}`;
        const rs = byTaskAction.get(key) ?? [];
        rs.push(o);
        byTaskAction.set(key, rs);
    }
    result.observationDigests = digests;
    if (incomplete)
        return { assessment: result, incomplete, regression, unknown };
    const tasks: LearningPairedTask[] = [], cfg = input.fresh.comparison!.config;
    for (const task of e.tasks) {
        // The fresh manifest freezes one replay time for both suites. Fixed suites can predate snapshots.
        const featureKey = digest(task.features);
        let selected = selections.get(featureKey);
        if (!selected) {
            const from = selectPolicy(input.fromSnapshot, e.arms, task.features, input.fresh.createdAt, e.fallbackId), to = selectPolicy(input.toSnapshot, e.arms, task.features, input.fresh.createdAt, e.fallbackId);
            selected = { ...(from ? { from: from.key } : {}), ...(to ? { to: to.key } : {}) };
            selections.set(featureKey, selected);
        }
        const from = selected.from, to = selected.to;
        if (!from || !to) {
            unknown = true;
            continue;
        }
        const a = byTaskAction.get(`${task.taskDigest}:${from}`)!, b = byTaskAction.get(`${task.taskDigest}:${to}`)!;
        const qa = mean(a.map(o => o.quality.state === 'verified' ? o.quality.value : NaN)), qb = mean(b.map(o => o.quality.state === 'verified' ? o.quality.value : NaN));
        const pa = mean(a.map(o => o.quality.state === 'verified' && o.quality.passed ? 1 : 0)), pb = mean(b.map(o => o.quality.state === 'verified' && o.quality.passed ? 1 : 0));
        const pair: LearningPairedTask = { taskDigest: task.taskDigest, fromAction: from, toAction: to, qualityDelta: qb - qa, passRateDelta: pb - pa };
        if (qb + 1e-12 < qa || pb + 1e-12 < pa)
            regression = true;
        if (cfg.objective === 'quality')
            pair.objectiveGain = qb - qa;
        else if (qa < cfg.qualityFloor || qb < cfg.qualityFloor)
            unknown = true;
        else if (cfg.objective === 'latency') {
            if ([...a, ...b].every(o => o.latency.state === 'observed')) {
                const av = mean(a.map(o => o.latency.state === 'observed' ? o.latency.durationMs : NaN)), bv = mean(b.map(o => o.latency.state === 'observed' ? o.latency.durationMs : NaN));
                if (av > 0)
                    pair.objectiveGain = (av - bv) / av;
                else
                    unknown = true;
            }
            else
                unknown = true;
        }
        else {
            const meaning = new Set([...a, ...b].map(o => o.usage?.costMeaning));
            if (meaning.size === 1 && !meaning.has(undefined) && !meaning.has('unavailable') && [...a, ...b].every(o => o.usage?.reportedCostUsd !== undefined)) {
                const av = mean(a.map(o => o.usage!.reportedCostUsd!)), bv = mean(b.map(o => o.usage!.reportedCostUsd!));
                if (av > 0)
                    pair.objectiveGain = (av - bv) / av;
                else
                    unknown = true;
            }
            else
                unknown = true;
        }
        if (pair.objectiveGain !== undefined) {
            if (pair.objectiveGain > 1e-12)
                result.wins++;
            else if (pair.objectiveGain < -1e-12) {
                result.losses++;
                regression = true;
            }
            else
                result.ties++;
        }
        tasks.push(pair);
    }
    result.tasks = tasks;
    const gains = tasks.flatMap(t => t.objectiveGain === undefined ? [] : [t.objectiveGain]);
    if (gains.length === tasks.length && gains.length) {
        result.meanGain = mean(gains);
        result.pValue = signP(result.wins, result.losses);
    }
    return { assessment: result, incomplete, regression, unknown };
}
export function assessGateEvidence(value: GateEvidenceInput): LearningGate {
    const input = ownObject(value, ['id', 'createdAt', 'domain', 'fresh', 'fixed', 'fromSnapshot', 'toSnapshot', 'observations']);
    const fresh = validateLearningRecord('episode', input.fresh), fixed = validateLearningRecord('episode', input.fixed), c = fresh.comparison;
    if (!c)
        throw new TypeError('Fresh comparison missing');
    const from = input.fromSnapshot ? validateLearningRecord('snapshot', input.fromSnapshot) : undefined, to = input.toSnapshot ? validateLearningRecord('snapshot', input.toSnapshot) : undefined;
    if (!Array.isArray(input.observations) || input.observations.length > 8192)
        throw new TypeError('Gate observation union exceeds 8192 rows');
    const observations = jsonClone(input.observations).map(value => { const r = ownObject(value, ['sequence', 'observation']); return { sequence: r.sequence, observation: validateLearningRecord('observation', r.observation) }; });
    if (input.createdAt < Math.max(fresh.createdAt, fixed.createdAt, from?.createdAt ?? 0, to?.createdAt ?? 0, observations.reduce((at, r) => Math.max(at, r.observation.createdAt), 0)))
        throw new TypeError('Gate timestamp violates evidence causal order');
    let incomparable = fresh.domain !== input.domain || fixed.domain !== input.domain || fresh.kind !== 'fresh' || fixed.kind !== 'fixed' || c.fixedEpisodeId !== fixed.id || fresh.definitionDigest !== fixed.definitionDigest || fresh.protocolDigest !== fixed.protocolDigest || digest(fresh.arms) !== digest(fixed.arms) || fresh.fallbackId !== fixed.fallbackId || fresh.repetitions !== fixed.repetitions || c.from !== (from?.digest ?? null) || c.to !== (to?.digest ?? null) || c.from === c.to;
    for (const snapshot of [from, to])
        if (snapshot) {
            const b = snapshot.binding;
            if (!b || b.definitionDigest !== fresh.definitionDigest || digest(b.actions) !== digest(fresh.arms) || b.fallbackId !== fresh.fallbackId || b.features.schema !== fresh.tasks[0]!.features.schema || b.features.dimensions !== fresh.tasks[0]!.features.values.length)
                incomparable = true;
        }
    if (fresh.createdAt < fixed.createdAt)
        incomparable = true;
    const featureIdentities = new Set([...fresh.tasks, ...fixed.tasks, ...(from?.rows.map(r => r.observation) ?? []), ...(to?.rows.map(r => r.observation) ?? [])].map(t => `${t.features.schema}:${t.features.values.length}`));
    if (featureIdentities.size !== 1)
        incomparable = true;
    const manifests = new Map([[fresh.id, fresh], [fixed.id, fixed]]);
    if (observations.some(r => { const e = manifests.get(r.observation.episodeId ?? ''); return e && (r.observation.createdAt < e.createdAt || r.sequence <= e.afterSequence); }))
        incomparable = true;
    const heldout = new Set([...fresh.tasks, ...fixed.tasks].map(t => t.taskDigest));
    if (new Set([...fresh.tasks, ...fixed.tasks].map(t => t.taskDigest)).size !== fresh.tasks.length + fixed.tasks.length)
        incomparable = true;
    for (const s of [from, to])
        if (s && (s.domain !== input.domain || s.through > fresh.afterSequence || s.createdAt > fresh.createdAt || digest(s.config) !== c.configDigest || s.rows.some(r => heldout.has(r.observation.taskDigest))))
            incomparable = true;
    if (new Set(observations.map(r => r.observation.id)).size !== observations.length || new Set(observations.map(r => r.sequence)).size !== observations.length || observations.some(r => !Number.isSafeInteger(r.sequence) || r.sequence < 1))
        incomparable = true;
    const normalized = { ...input, fresh, fixed, observations, ...(from ? { fromSnapshot: from } : {}), ...(to ? { toSnapshot: to } : {}) };
    const selections = new Map<string, {
        from?: string;
        to?: string;
    }>();
    const fa = incomparable ? { assessment: empty(fixed, observations), incomplete: false, regression: false, unknown: false } : assess(fixed, observations, normalized, selections), fr = incomparable ? { assessment: empty(fresh, observations), incomplete: false, regression: false, unknown: false } : assess(fresh, observations, normalized, selections);
    let reason: LearningGate['reason'] = 'SUPPORTED';
    if (incomparable)
        reason = 'INCOMPARABLE';
    else if (fa.incomplete || fr.incomplete)
        reason = 'INCOMPLETE';
    else if (fa.regression || fr.regression)
        reason = 'REGRESSION';
    else if (fa.unknown || fr.unknown || fr.assessment.tasks.length < c.config.minFreshTasks || fr.assessment.pValue === undefined || fr.assessment.pValue > c.config.alpha || fr.assessment.meanGain === undefined || fr.assessment.meanGain < c.config.minImprovement || fr.assessment.meanGain <= 0)
        reason = 'INSUFFICIENT';
    return sealLearningRecord('gate', { format: 1, id: input.id, domain: input.domain, createdAt: input.createdAt, mode: c.operation, expectedGeneration: c.expectedGeneration, from: c.from, to: c.to, definitionDigest: fresh.definitionDigest, configDigest: c.configDigest, outcome: reason === 'SUPPORTED' ? c.operation : 'keep', reason, fixed: fa.assessment, fresh: fr.assessment });
}
