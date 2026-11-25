import { freeze, hash, jsonClone } from '../../shared/json.js';
import type { LearningAction, LearningFeatures, LearningPolicyConfig, LearningPolicyBinding, LearningPrediction, LearningSnapshot, SequencedObservation } from './types.js';
import { action as validateAction } from './validation-shapes.js';
import { sealLearningRecord, validateFeatures, validateLearningRecord, validatePolicyConfig } from './validation.js';
export const DEFAULT_LEARNING_POLICY: Readonly<LearningPolicyConfig> = freeze({ objective: 'quality', minDistinctTasks: 3, minSimilarity: .2, maxAgeMs: 90 * 86400000, halfLifeMs: 30 * 86400000, qualityFloor: .5, maxRows: 512, alpha: .05, minImprovement: .01, minFreshTasks: 6 });
export function buildSnapshot(domain: string, config: LearningPolicyConfig, through: number, rows: readonly SequencedObservation[], createdAt: number, binding?: LearningPolicyBinding): LearningSnapshot {
    hash(domain);
    const cfg = validatePolicyConfig(config);
    if (!Number.isSafeInteger(through) || through < 0)
        throw new TypeError('Invalid cutoff');
    const sorted = jsonClone([...rows]).sort((a, b) => a.sequence - b.sequence);
    let schema: string | undefined, dimensions: number | undefined, last = 0;
    for (const r of sorted) {
        const o = validateLearningRecord('observation', r.observation);
        if (!Number.isSafeInteger(r.sequence) || r.sequence <= last || r.sequence > through || o.domain !== domain || o.split !== 'train' || o.quality.state !== 'verified' || o.createdAt > createdAt)
            throw new TypeError('Invalid training row');
        last = r.sequence;
        if (schema && (schema !== o.features.schema || dimensions !== o.features.values.length))
            throw new TypeError('Mixed schemas');
        schema = o.features.schema;
        dimensions = o.features.values.length;
    }
    return sealLearningRecord('snapshot', { format: 1, domain, config: cfg, through, rows: sorted.slice(-cfg.maxRows), createdAt, ...(binding ? { binding } : {}) });
}
function cosine(a: readonly number[], b: readonly number[]): number { return a.length === b.length ? a.reduce((n, x, i) => n + x * b[i]!, 0) : 0; }
interface Neighbor {
    weight: number;
    quality: number;
    latency?: number;
    cost?: number;
    meaning?: string;
}
export function predict(snapshot: LearningSnapshot, features: LearningFeatures, actions: readonly LearningAction[], asOf: number): readonly LearningPrediction[] {
    const s = validateLearningRecord('snapshot', snapshot), f = validateFeatures(features), cfg = s.config;
    actions = jsonClone(actions);
    actions.forEach(validateAction);
    if (!Number.isSafeInteger(asOf) || asOf < 0)
        throw new TypeError('Invalid prediction time');
    return freeze(actions.map(a => {
        const base = { actionKey: a.key, support: 0, effectiveSupport: 0 };
        if (!Math.hypot(...f.values))
            return { ...base, reason: 'cold-start' as const };
        const all = s.rows.filter(r => r.observation.action.key === a.key && r.observation.features.schema === f.schema && r.observation.features.values.length === f.values.length && r.observation.createdAt <= asOf);
        if (!all.length)
            return { ...base, reason: 'cold-start' as const };
        const recent = all.filter(r => asOf - r.observation.createdAt <= cfg.maxAgeMs);
        if (!recent.length)
            return { ...base, reason: 'stale' as const };
        const groups = new Map<string, SequencedObservation[]>();
        for (const r of recent) {
            if (cosine(f.values, r.observation.features.values) < cfg.minSimilarity)
                continue;
            const list = groups.get(r.observation.taskDigest) ?? [];
            list.push(r);
            groups.set(r.observation.taskDigest, list);
        }
        if (!groups.size)
            return { ...base, reason: 'out-of-distribution' as const };
        const neighbors: Neighbor[] = [];
        for (const rs of groups.values()) {
            // Each executable task is one vote; repetitions improve its mean, never its support.
            const weights = rs.map(r => Math.max(0, cosine(f.values, r.observation.features.values)) * Math.pow(2, -(asOf - r.observation.createdAt) / cfg.halfLifeMs));
            const total = weights.reduce((x, y) => x + y, 0);
            if (!total)
                continue;
            const n: Neighbor = { weight: Math.max(...weights), quality: rs.reduce((sum, r, i) => sum + (r.observation.quality.state === 'verified' ? r.observation.quality.value : 0) * weights[i]!, 0) / total };
            if (rs.every(r => r.observation.latency.state === 'observed'))
                n.latency = rs.reduce((sum, r, i) => sum + (r.observation.latency.state === 'observed' ? r.observation.latency.durationMs : 0) * weights[i]!, 0) / total;
            const meanings = new Set(rs.map(r => r.observation.usage?.costMeaning));
            if (meanings.size === 1 && !meanings.has(undefined) && !meanings.has('unavailable') && rs.every(r => r.observation.usage?.reportedCostUsd !== undefined)) {
                n.meaning = rs[0]!.observation.usage!.costMeaning;
                n.cost = rs.reduce((sum, r, i) => sum + r.observation.usage!.reportedCostUsd! * weights[i]!, 0) / total;
            }
            neighbors.push(n);
        }
        const total = neighbors.reduce((sum, n) => sum + n.weight, 0), squares = neighbors.reduce((sum, n) => sum + n.weight * n.weight, 0);
        if (!total)
            return { ...base, reason: 'stale' as const };
        // Kish support discounts imbalance; total recency mass also prevents old equal-weight votes retaining confidence.
        const effectiveSupport = Math.min(total, total * total / squares), support = neighbors.length;
        const meanQuality = neighbors.reduce((sum, n) => sum + n.weight * n.quality, 0) / total;
        // Hoeffding-style weighted-neighbor heuristic, conservative and not a calibrated probability claim.
        const radius = Math.sqrt(Math.log(2 / cfg.alpha) / (2 * Math.max(effectiveSupport, Number.EPSILON)));
        const result: LearningPrediction = { actionKey: a.key, support, effectiveSupport, meanQuality, lowerQuality: Math.max(0, meanQuality - radius), upperQuality: Math.min(1, meanQuality + radius), reason: support >= cfg.minDistinctTasks && effectiveSupport >= cfg.minDistinctTasks ? 'supported' : 'cold-start' };
        if (neighbors.every(n => n.latency !== undefined))
            result.latencyMs = neighbors.reduce((sum, n) => sum + n.weight * n.latency!, 0) / total;
        const meanings = new Set(neighbors.map(n => n.meaning));
        if (meanings.size === 1 && !meanings.has(undefined) && neighbors.every(n => n.cost !== undefined)) {
            result.costUsd = neighbors.reduce((sum, n) => sum + n.weight * n.cost!, 0) / total;
            result.costMeaning = neighbors[0]!.meaning!;
        }
        if (result.reason === 'supported' && (cfg.objective === 'latency' && result.latencyMs === undefined || cfg.objective === 'cost' && result.costUsd === undefined))
            result.reason = 'unknown-metric';
        return result;
    }));
}
export function selectPolicyDecision(snapshot: LearningSnapshot | undefined, orderedActions: readonly LearningAction[], features: LearningFeatures, asOf: number, fallbackId?: string): { action?: LearningAction; reason: 'supported' | 'incumbent' } {
    orderedActions = jsonClone(orderedActions);
    orderedActions.forEach(validateAction);
    features = validateFeatures(features);
    if (!Number.isSafeInteger(asOf) || asOf < 0)
        throw new TypeError('Invalid prediction time');
    const primary = orderedActions.filter(a => a.id !== fallbackId), pool = primary.length ? primary : orderedActions.filter(a => a.id === fallbackId);
    const incumbent = { ...(pool[0] === undefined ? {} : { action: pool[0] }), reason: 'incumbent' as const };
    if (!snapshot)
        return incumbent;
    const ps = predict(snapshot, features, pool, asOf);
    const eligible = pool.map((a, i) => ({ a, p: ps[i]! })).filter(({ p }) => p.reason === 'supported' && p.lowerQuality !== undefined && p.lowerQuality >= snapshot.config.qualityFloor);
    if (!eligible.length)
        return incumbent;
    const cfg = snapshot.config;
    // Monetary figures with different meanings have no comparable order.
    if (cfg.objective === 'cost' && new Set(eligible.map(({ p }) => p.costMeaning)).size !== 1)
        return incumbent;
    eligible.sort((x, y) => cfg.objective === 'quality' ? y.p.lowerQuality! - x.p.lowerQuality! : cfg.objective === 'latency' ? x.p.latencyMs! - y.p.latencyMs! : x.p.costUsd! - y.p.costUsd!);
    const action = eligible[0]?.a;
    return action === undefined ? incumbent : { action, reason: 'supported' };
}

/** Preserve the public action-only selector; both APIs share one ranking/fallback determination. */
export function selectPolicy(snapshot: LearningSnapshot | undefined, orderedActions: readonly LearningAction[], features: LearningFeatures, asOf: number, fallbackId?: string): LearningAction | undefined {
    return selectPolicyDecision(snapshot, orderedActions, features, asOf, fallbackId).action;
}
