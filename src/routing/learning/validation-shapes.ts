import { digest, hash, identifier, object } from '../../shared/json.js';
import type { LearningAction, LearningFeatures, LearningPolicyConfig } from './types.js';
export function exact(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, any> {
    object(v, [...required, ...optional]);
    for (const k of required)
        if (!Object.hasOwn(v, k))
            throw new TypeError(`Missing ${k}`);
}
export function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
    if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
        throw new TypeError('Invalid integer');
}
export function number(v: unknown, min = 0, max = Number.MAX_VALUE): asserts v is number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
        throw new TypeError('Invalid number');
}
export function choice(v: unknown, choices: readonly unknown[]): void {
    if (!choices.includes(v))
        throw new TypeError('Invalid enum');
}
export function list(v: unknown, max = 32768): asserts v is any[] {
    if (!Array.isArray(v) || v.length > max)
        throw new TypeError('Invalid list');
}
export function ref(v: unknown): void {
    if (v !== null)
        hash(v);
}
export function features(v: unknown): asserts v is LearningFeatures {
    exact(v, ['schema', 'values']);
    identifier(v.schema);
    list(v.values, 512);
    if (!v.values.length)
        throw new TypeError('Empty vector');
    for (const x of v.values)
        number(x, -1, 1);
    const n = Math.hypot(...v.values);
    if (n !== 0 && Math.abs(n - 1) > 1e-6)
        throw new TypeError('Unnormalized features');
}
export function config(v: unknown): asserts v is LearningPolicyConfig { exact(v, ['objective', 'minDistinctTasks', 'minSimilarity', 'maxAgeMs', 'halfLifeMs', 'qualityFloor', 'maxRows', 'alpha', 'minImprovement', 'minFreshTasks']); choice(v.objective, ['quality', 'latency', 'cost']); integer(v.minDistinctTasks, 1, 100000); number(v.minSimilarity, 0, 1); integer(v.maxAgeMs, 1); integer(v.halfLifeMs, 1); number(v.qualityFloor, 0, 1); integer(v.maxRows, 1, 32768); number(v.alpha, Number.MIN_VALUE, .5); number(v.minImprovement, 0, 1); integer(v.minFreshTasks, 1, 100000); }
export function action(v: unknown): asserts v is LearningAction {
    exact(v, ['id', 'model', 'provider', 'modelId', 'optionsDigest', 'executionDigest', 'evidenceScope', 'key']);
    choice(v.evidenceScope, ['model', 'requested-system']);
    for (const k of ['id', 'model', 'provider', 'modelId'])
        identifier(v[k]);
    for (const k of ['optionsDigest', 'executionDigest', 'key'])
        hash(v[k]);
    const { id: _, key: __, ...body } = v;
    if (digest(body) !== v.key)
        throw new TypeError('Action key mismatch');
}
export function pointer(v: unknown): void {
    exact(v, ['generation', 'active', 'previous']);
    integer(v.generation);
    ref(v.active);
    ref(v.previous);
    if (v.generation === 0 && (v.active !== null || v.previous !== null))
        throw new TypeError('Initial pointer mismatch');
}
export function quality(v: unknown): void {
    object(v);
    if (v.state === 'verified') {
        exact(v, ['state', 'value', 'passed']);
        number(v.value, 0, 1);
        if (typeof v.passed !== 'boolean')
            throw new TypeError('Invalid pass');
    }
    else {
        exact(v, ['state', 'reason']);
        choice(v.state, ['unknown']);
        identifier(v.reason);
    }
}
export function latency(v: unknown): void {
    object(v);
    if (v.state === 'unknown') {
        exact(v, ['state']);
    }
    else {
        exact(v, ['state', 'durationMs']);
        choice(v.state, ['observed', 'right-censored']);
        number(v.durationMs);
    }
}
export function usage(v: unknown): void {
    exact(v, ['costMeaning'], ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reportedCostUsd', 'perModel']);
    choice(v.costMeaning, ['provider-reported', 'api-equivalent', 'estimate', 'unavailable']);
    for (const k of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens'])
        if (k in v)
            integer(v[k]);
    if ('reportedCostUsd' in v)
        number(v.reportedCostUsd);
    if ('perModel' in v) {
        object(v.perModel);
        if (Object.keys(v.perModel).length > 64)
            throw new TypeError('Too many per-model usage entries');
        for (const [k, m] of Object.entries(v.perModel)) {
            identifier(k);
            exact(m, [], ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reportedCostUsd']);
            for (const [n, x] of Object.entries(m))
                n === 'reportedCostUsd' ? number(x) : integer(x);
        }
    }
}
export function prediction(v: unknown): void {
    exact(v, ['actionKey', 'support', 'effectiveSupport', 'reason'], ['meanQuality', 'lowerQuality', 'upperQuality', 'latencyMs', 'costUsd', 'costMeaning']);
    hash(v.actionKey);
    integer(v.support);
    number(v.effectiveSupport, 0, v.support);
    choice(v.reason, ['supported', 'cold-start', 'out-of-distribution', 'stale', 'unknown-metric']);
    for (const k of ['meanQuality', 'lowerQuality', 'upperQuality'])
        if (k in v)
            number(v[k], 0, 1);
    for (const k of ['latencyMs', 'costUsd'])
        if (k in v)
            number(v[k]);
    if ('costMeaning' in v)
        choice(v.costMeaning, ['provider-reported', 'api-equivalent', 'estimate']);
}
export function assessment(v: unknown): void {
    exact(v, ['episodeId', 'episodeDigest', 'observationDigests', 'expectedCells', 'verifiedCells', 'tasks', 'wins', 'losses', 'ties'], ['pValue', 'meanGain']);
    identifier(v.episodeId);
    hash(v.episodeDigest);
    list(v.observationDigests);
    for (const d of v.observationDigests)
        hash(d);
    integer(v.expectedCells);
    integer(v.verifiedCells, 0, v.expectedCells);
    for (const k of ['wins', 'losses', 'ties'])
        integer(v[k]);
    if ('pValue' in v)
        number(v.pValue, 0, 1);
    if ('meanGain' in v)
        number(v.meanGain, -Number.MAX_VALUE);
    list(v.tasks);
    for (const t of v.tasks) {
        exact(t, ['taskDigest', 'fromAction', 'toAction'], ['qualityDelta', 'passRateDelta', 'objectiveGain']);
        hash(t.taskDigest);
        hash(t.fromAction);
        hash(t.toAction);
        for (const k of ['qualityDelta', 'passRateDelta', 'objectiveGain'])
            if (k in t)
                number(t[k], -Number.MAX_VALUE);
    }
}
export function binding(v: unknown): void {
    exact(v, ['definitionDigest', 'actions', 'features'], ['fallbackId']);
    hash(v.definitionDigest);
    list(v.actions, 64);
    if (!v.actions.length)
        throw new TypeError('Empty policy binding actions');
    v.actions.forEach(action);
    if (new Set(v.actions.map(a => a.id)).size !== v.actions.length || new Set(v.actions.map(a => a.key)).size !== v.actions.length)
        throw new TypeError('Duplicate policy binding action');
    if (v.fallbackId !== undefined) {
        identifier(v.fallbackId);
        if (!v.actions.some(a => a.id === v.fallbackId))
            throw new TypeError('Policy binding fallback missing');
    }
    exact(v.features, ['schema', 'dimensions']);
    identifier(v.features.schema);
    integer(v.features.dimensions, 1, 512);
}
