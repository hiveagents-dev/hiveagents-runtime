import { digest, freeze, hash, identifier, jsonClone } from '../../shared/json.js';
import type { EvidenceMap, LearningDomain, LearningFeatures, LearningPolicyConfig } from './types.js';
import { action, assessment, binding, choice, config, exact, features, integer, latency, list, pointer, prediction, quality, ref, usage } from './validation-shapes.js';
export function learningDomainDigest(value: LearningDomain): string { const v = jsonClone(value); exact(v, ['id', 'sourceDigest', 'scorerDigest', 'protocolDigest']); identifier(v.id); hash(v.sourceDigest); hash(v.scorerDigest); hash(v.protocolDigest); return digest(v); }
export function validateFeatures(value: unknown): LearningFeatures { const v = jsonClone(value); features(v); return freeze(v); }
export function validatePolicyConfig(value: unknown): LearningPolicyConfig { const v = jsonClone(value); config(v); return freeze(v); }
const validatedRecords = new WeakMap<object, keyof EvidenceMap>();
const headers = ['format', 'domain', 'digest'];
function base(v: Record<string, any>, id = true): void {
    if (v.format !== 1)
        throw new TypeError('Invalid learning format');
    hash(v.domain);
    hash(v.digest);
    if (id)
        identifier(v.id);
}
function cells(v: Record<string, any>): void {
    list(v.arms, 64);
    if (!v.arms.length)
        throw new TypeError('No episode arms');
    v.arms.forEach(action);
    if (new Set(v.arms.map((a: any) => a.key)).size !== v.arms.length || new Set(v.arms.map((a: any) => a.id)).size !== v.arms.length)
        throw new TypeError('Duplicate episode arm');
    if ('fallbackId' in v) {
        identifier(v.fallbackId);
        if (!v.arms.some((a: any) => a.id === v.fallbackId))
            throw new TypeError('Unknown fallback');
    }
    list(v.tasks, 1024);
    if (!v.tasks.length)
        throw new TypeError('No episode tasks');
    for (const t of v.tasks) {
        exact(t, ['taskDigest', 'features']);
        hash(t.taskDigest);
        features(t.features);
    }
    if (new Set(v.tasks.map((t: any) => t.taskDigest)).size !== v.tasks.length)
        throw new TypeError('Duplicate task');
    if (new Set(v.tasks.map((t: any) => `${t.features.schema}:${t.features.values.length}`)).size !== 1)
        throw new TypeError('Mixed feature schema');
    integer(v.repetitions, 1, 1000);
    list(v.cells, 4096);
    if (v.cells.length !== v.tasks.length * v.arms.length * v.repetitions)
        throw new TypeError('Incomplete Cartesian cells');
    const unique = new Set<string>(), attempts = new Set<string>(), observations = new Set<string>();
    for (const c of v.cells) {
        exact(c, ['taskDigest', 'actionKey', 'repetition', 'attemptId', 'observationId']);
        hash(c.taskDigest);
        hash(c.actionKey);
        integer(c.repetition, 0, v.repetitions - 1);
        identifier(c.attemptId);
        identifier(c.observationId);
        if (!v.tasks.some((t: any) => t.taskDigest === c.taskDigest) || !v.arms.some((a: any) => a.key === c.actionKey))
            throw new TypeError('Unknown cell');
        const key = `${c.taskDigest}:${c.actionKey}:${c.repetition}`;
        if (unique.has(key) || attempts.has(c.attemptId) || observations.has(c.observationId))
            throw new TypeError('Duplicate cell');
        unique.add(key);
        attempts.add(c.attemptId);
        observations.add(c.observationId);
    }
}
function check(kind: keyof EvidenceMap, v: Record<string, any>): void {
    switch (kind) {
        case 'observation':
        case 'attempt': {
            const terminal = kind === 'observation';
            exact(v, [...headers, 'id', 'decisionId', 'decisionDigest', 'action', 'taskDigest', 'features', 'split', ...(terminal ? ['attemptId', 'outcome', 'quality', 'latency', 'createdAt'] : ['startedAt', 'observationId'])], ['episodeId', 'repetition', ...(terminal ? ['usage', 'observedModels', 'identityAfter'] : [])]);
            base(v);
            hash(v.decisionDigest);
            identifier(v.decisionId);
            action(v.action);
            hash(v.taskDigest);
            features(v.features);
            choice(v.split, ['train', 'fixed', 'fresh']);
            integer(terminal ? v.createdAt : v.startedAt);
            if (!terminal)
                identifier(v.observationId);
            if (v.split === 'train') {
                if ('episodeId' in v || 'repetition' in v)
                    throw new TypeError('Training cannot claim holdout');
            }
            else {
                identifier(v.episodeId);
                integer(v.repetition);
            }
            if (terminal) {
                identifier(v.attemptId);
                choice(v.outcome, ['completed', 'refused', 'failed', 'aborted', 'timeout', 'verifier-error', 'identity-drift']);
                quality(v.quality);
                latency(v.latency);
                if (v.quality.state === 'verified' && v.outcome !== 'completed')
                    throw new TypeError('Only completed observations may be verified');
                if ('usage' in v)
                    usage(v.usage);
                if ('observedModels' in v) {
                    list(v.observedModels, 64);
                    for (const m of v.observedModels)
                        identifier(m);
                }
                if ('identityAfter' in v)
                    hash(v.identityAfter);
                if (v.observedModels !== undefined && v.usage?.perModel !== undefined) {
                    const normalize = (model: string) => model === v.action.model ? v.action.modelId : model;
                    const observed = new Set(v.observedModels.map(normalize)), usageModels = new Set(Object.keys(v.usage.perModel).map(normalize));
                    if (observed.size !== usageModels.size || [...observed].some(model => !usageModels.has(model)))
                        throw new TypeError('Inconsistent observed model sets');
                }
                if (v.quality.state === 'verified') {
                    const matches = (model: string): boolean => model === v.action.modelId || model === v.action.model;
                    if (v.identityAfter !== undefined && v.identityAfter !== v.action.executionDigest
                        || v.action.evidenceScope === 'model' && (v.observedModels?.some((model: string) => !matches(model))
                            || Object.keys(v.usage?.perModel ?? {}).some(model => !matches(model)))) {
                        throw new TypeError('Verified observation contains model or execution identity drift');
                    }
                }
            }
            break;
        }
        case 'snapshot': {
            exact(v, [...headers, 'config', 'through', 'rows', 'createdAt'], ['binding']);
            if (v.binding !== undefined)
                binding(v.binding);
            base(v, false);
            config(v.config);
            integer(v.through);
            integer(v.createdAt);
            list(v.rows, v.config.maxRows);
            let last = 0;
            let schema: string | undefined;
            let dimensions: number | undefined;
            for (const r of v.rows) {
                exact(r, ['sequence', 'observation']);
                integer(r.sequence, 1, v.through);
                if (r.sequence <= last)
                    throw new TypeError('Unordered snapshot');
                last = r.sequence;
                const o = validateLearningRecord('observation', r.observation);
                if (o.domain !== v.domain || o.split !== 'train' || o.quality.state !== 'verified' || o.createdAt > v.createdAt)
                    throw new TypeError('Invalid snapshot training row');
                if (schema && (schema !== o.features.schema || dimensions !== o.features.values.length))
                    throw new TypeError('Mixed feature schema');
                if (v.binding && (v.binding.features.schema !== o.features.schema || v.binding.features.dimensions !== o.features.values.length || !v.binding.actions.some((a: any) => a.key === o.action.key)))
                    throw new TypeError('Snapshot row outside bound feature/action scope');
                schema = o.features.schema;
                dimensions = o.features.values.length;
            }
            break;
        }
        case 'decision': {
            exact(v, [...headers, 'id', 'createdAt', 'taskDigest', 'featuresDigest', 'definitionDigest', 'policy', 'mode', 'reason', 'candidates', 'predictions', 'nativeDispatches'], ['selected']);
            base(v);
            integer(v.createdAt);
            for (const k of ['taskDigest', 'featuresDigest', 'definitionDigest'])
                hash(v[k]);
            ref(v.policy);
            choice(v.mode, ['fixed', 'auto', 'matrix']);
            choice(v.reason, ['FIXED', 'INCUMBENT', 'LEARNED', 'MATRIX', 'FALLBACK', 'NO_ROUTE', 'ABORTED', 'TIMEOUT']);
            if (v.nativeDispatches !== 0)
                throw new TypeError('Proposal cannot dispatch');
            list(v.candidates, 64);
            list(v.predictions, 64);
            v.predictions.forEach(prediction);
            const ids = new Set(), keys = new Set();
            for (const c of v.candidates) {
                exact(c, ['id', 'model', 'provider', 'modelId', 'status', 'code'], ['action']);
                for (const k of ['id', 'model', 'provider', 'modelId'])
                    identifier(c[k]);
                if (ids.has(c.id))
                    throw new TypeError('Duplicate candidate');
                ids.add(c.id);
                choice(c.status, ['eligible', 'excluded', 'not-evaluated']);
                choice(c.code, ['READY', 'NOT_NEEDED', 'NOT_IN_RULE', 'PROVIDER_NOT_ALLOWED', 'MODEL_UNAVAILABLE', 'MODEL_UNVERIFIED', 'CLI_MISSING', 'AUTH_REQUIRED', 'AUTH_UNKNOWN', 'SUBSCRIPTION_REQUIRED', 'CLI_UNSUPPORTED', 'POLICY_UNSUPPORTED', 'PROBE_FAILED', 'ABORTED', 'TIMEOUT']);
                if (c.action) {
                    action(c.action);
                    if (c.action.id !== c.id || c.action.model !== c.model || c.action.provider !== c.provider || c.action.modelId !== c.modelId || keys.has(c.action.key))
                        throw new TypeError('Candidate action mismatch');
                    keys.add(c.action.key);
                }
                if (c.status === 'eligible' && (!c.action || c.code !== 'READY'))
                    throw new TypeError('Eligible action missing');
            }
            if (v.selected) {
                action(v.selected);
                if (!v.candidates.some((c: any) => c.status === 'eligible' && c.action?.key === v.selected.key && digest(c.action) === digest(v.selected)))
                    throw new TypeError('Selected action outside candidates');
            }
            break;
        }
        case 'episode': {
            exact(v, [...headers, 'id', 'kind', 'createdAt', 'definitionDigest', 'protocolDigest', 'afterSequence', 'arms', 'tasks', 'repetitions', 'cells'], ['comparison', 'fallbackId']);
            base(v);
            integer(v.createdAt);
            integer(v.afterSequence);
            hash(v.definitionDigest);
            hash(v.protocolDigest);
            choice(v.kind, ['fixed', 'fresh']);
            cells(v);
            if (v.kind === 'fresh' && !v.comparison || v.kind === 'fixed' && v.comparison)
                throw new TypeError('Episode comparison mismatch');
            if (v.comparison) {
                const c = v.comparison;
                exact(c, ['expectedGeneration', 'from', 'to', 'operation', 'fixedEpisodeId', 'config', 'configDigest']);
                integer(c.expectedGeneration);
                ref(c.from);
                ref(c.to);
                choice(c.operation, ['promote', 'rollback']);
                identifier(c.fixedEpisodeId);
                config(c.config);
                hash(c.configDigest);
                if (digest(c.config) !== c.configDigest || c.from === c.to)
                    throw new TypeError('Invalid comparison');
            }
            break;
        }
        case 'gate': {
            exact(v, [...headers, 'id', 'createdAt', 'mode', 'expectedGeneration', 'from', 'to', 'definitionDigest', 'configDigest', 'outcome', 'reason', 'fixed', 'fresh']);
            base(v);
            integer(v.createdAt);
            integer(v.expectedGeneration);
            ref(v.from);
            ref(v.to);
            hash(v.definitionDigest);
            hash(v.configDigest);
            choice(v.mode, ['promote', 'rollback']);
            choice(v.outcome, ['keep', 'promote', 'rollback']);
            choice(v.reason, ['SUPPORTED', 'INCOMPLETE', 'REGRESSION', 'INSUFFICIENT', 'INCOMPARABLE']);
            assessment(v.fixed);
            assessment(v.fresh);
            if (v.outcome !== 'keep' && v.outcome !== v.mode)
                throw new TypeError('Gate outcome mismatch');
            break;
        }
        default: throw new TypeError('Unknown learning record kind');
        case 'gate-commit':
            exact(v, [...headers, 'id', 'gateDigest', 'status', 'before', 'after', 'createdAt']);
            base(v);
            hash(v.gateDigest);
            choice(v.status, ['kept', 'promoted', 'rolled-back', 'stale']);
            pointer(v.before);
            pointer(v.after);
            integer(v.createdAt);
            break;
    }
    const { digest: claimed, ...body } = v;
    if (digest(body) !== claimed)
        throw new TypeError('Learning record digest mismatch');
}
/** Only exact immutable objects produced here are trusted on subsequent reads. External frozen values still validate fully. */
export function validateLearningRecord<K extends keyof EvidenceMap>(kind: K, value: unknown): EvidenceMap[K] {
    if (value && typeof value === 'object' && validatedRecords.get(value) === kind)
        return value as EvidenceMap[K];
    const v = jsonClone(value);
    exact(v, [], Object.keys(v as object));
    check(kind, v);
    const result = freeze(v) as unknown as EvidenceMap[K];
    validatedRecords.set(result, kind);
    return result;
}
export function sealLearningRecord<K extends keyof EvidenceMap>(kind: K, body: Omit<EvidenceMap[K], 'digest'>): EvidenceMap[K] { const v = jsonClone(body); return validateLearningRecord(kind, { ...v, digest: digest(v) }); }
