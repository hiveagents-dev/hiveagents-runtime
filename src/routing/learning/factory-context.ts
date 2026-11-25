import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { compileOutputSchema } from '../../core/schema.js';
import { OperationScope } from '../../control/operation-scope.js';
import { TimeoutError } from '../../public/errors.js';
import type { Runtime } from '../../core/runtime.js';
import type { AgentOptions, ModelInfo } from '../../public/types.js';
import { normalize } from '../config.js';
import { digest, freeze, hash, identifier, method, object, ownObject, snapshot, strings } from '../../shared/json.js';
import { hashTaskFeatures, inputDigest } from './features.js';
import { validateFeatures } from './validation.js';
import type { LearningArm, LearningContext, LearningDefinition, LearningFeatures, LearningProfile } from './types.js';
export const CONTEXT_KEYS = ['runtime', 'task', 'id', 'signal', 'timeoutMs', 'evaluationArmId'] as const;
export interface CapturedSelection {
    runtime: Runtime;
    id: string;
    taskDigest: string;
    text: string;
    features: LearningFeatures;
    signal?: AbortSignal;
    timeoutMs: number;
    evaluationArmId?: string;
    cwd: string;
    mode: 'fixed' | 'auto';
    arms: readonly {
        id: string;
        model: ModelInfo;
        options: Readonly<Omit<AgentOptions, 'model'>>;
        optionsDigest: string;
        evidenceScope: 'model' | 'requested-system';
    }[];
    auto?: {
        providers?: readonly string[];
        allowUnverifiedModels: boolean;
        allowUnknownAuth: boolean;
    };
    fallbackId?: string;
    definitionDigest: string;
    outputSchema?: Readonly<Record<string, unknown>>;
}
const profilePolicyKeys = ['context', 'permissions', 'providerOptions'] as const;

function profileRegistry(profiles: LearningDefinition['profiles'], shared: Omit<AgentOptions, 'model'>, runtime: Runtime): void {
    if (profiles === undefined)
        return;
    object(profiles);
    const entries = Object.entries(profiles);
    if (entries.length > 64)
        throw new TypeError('Too many learning profiles');
    for (const [id, profile] of entries) {
        identifier(id);
        object(profile, ['provider', ...profilePolicyKeys]);
        identifier(profile.provider);
        runtime.registration(profile.provider);
        for (const key of profilePolicyKeys)
            if (Object.hasOwn(profile, key) && Object.hasOwn(shared, key))
                throw new TypeError(`Learning profile cannot override shared ${key}`);
        if (profile.providerOptions !== undefined) {
            const provider = profile.provider;
            if (provider === 'claude' || provider === 'codex') {
                object(profile.providerOptions, [provider]);
            }
            else {
                object(profile.providerOptions, ['external']);
                if (profile.providerOptions.external !== undefined)
                    object(profile.providerOptions.external, [provider]);
            }
        }
    }
}

function profileFor(profiles: LearningDefinition['profiles'], arm: LearningArm): Omit<LearningProfile, 'provider'> {
    if (arm.profile === undefined)
        return {};
    identifier(arm.profile);
    const profile = profiles && Object.hasOwn(profiles, arm.profile) ? profiles[arm.profile] : undefined;
    if (!profile)
        throw new TypeError('Unknown learning profile');
    const { provider: _provider, ...options } = profile;
    return options;
}

export function captureSelection(definition: LearningDefinition, context: LearningContext): CapturedSelection {
    const c = ownObject(context, CONTEXT_KEYS);
    if (!c.runtime || typeof c.runtime !== 'object' || types.isProxy(c.runtime))
        throw new TypeError('A Runtime is required');
    method(c.runtime, 'resolveModel');
    method(c.runtime, 'registration');
    definition = snapshot(definition, true);
    object(definition);
    const task = snapshot(c.task);
    object(task, ['id', 'version', 'inputDigest', 'text', 'features']);
    identifier(task.id);
    identifier(task.version);
    hash(task.inputDigest);
    if (typeof task.text !== 'string' || task.text.length > 50000 || inputDigest(task.text) !== task.inputDigest)
        throw new TypeError('Task input digest mismatch');
    const features = task.features === undefined ? hashTaskFeatures(task.text) : task.features;
    validateFeatures(features);
    const id = c.id ?? randomUUID();
    identifier(id);
    const timeoutMs = c.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
        throw new RangeError('Invalid timeoutMs');
    if (c.signal !== undefined && (types.isProxy(c.signal) || !(c.signal instanceof AbortSignal)))
        throw new TypeError('Invalid AbortSignal');
    if (c.evaluationArmId !== undefined)
        identifier(c.evaluationArmId);
    const fixed = typeof definition.model === 'string';
    const rawArms: readonly LearningArm[] = fixed ? [{ id: 'fixed', model: definition.model as string }] : (() => {
        const auto = definition.model;
        object(auto, ['mode', 'candidates', 'fallback', 'providers', 'allowUnverifiedModels', 'allowUnknownAuth']);
        if (auto.mode !== 'auto' || !Array.isArray(auto.candidates) || !auto.candidates.length || auto.candidates.length > 64)
            throw new TypeError('Invalid learning arms');
        for (const name of ['allowUnverifiedModels', 'allowUnknownAuth'] as const)
            if (auto[name] !== undefined && typeof auto[name] !== 'boolean')
                throw new TypeError('Invalid learning filter');
        if (auto.providers !== undefined) {
            strings(auto.providers, 64);
            for (const provider of auto.providers)
                c.runtime.registration(provider);
        }
        return auto.candidates as unknown as LearningArm[];
    })();
    const ids = new Set<string>(), optionKeys = new Set<string>();
    const { model: _model, profiles, outputSchema, ...common } = definition;
    let outputSchemaDigest: string | undefined;
    if (outputSchema !== undefined) {
        object(outputSchema);
        compileOutputSchema(outputSchema);
        outputSchemaDigest = digest(outputSchema);
    }
    profileRegistry(profiles, common, c.runtime);
    const arms = rawArms.map(arm => {
        object(arm, ['id', 'model', 'effort', 'evidenceScope', 'profile']);
        identifier(arm.id);
        if (ids.has(arm.id))
            throw new TypeError('Duplicate arm ID');
        ids.add(arm.id);
        if (arm.effort !== undefined && (typeof arm.effort !== 'string' || !arm.effort.trim()))
            throw new TypeError('Invalid effort');
        const normalized = normalize({ ...common, ...profileFor(profiles, arm), ...(arm.effort === undefined ? {} : { effort: arm.effort }), model: arm.model }, c.runtime);
        const model = snapshot(normalized.models[0]!);
        if (arm.profile !== undefined && profiles![arm.profile]!.provider !== model.provider)
            throw new TypeError('Learning profile provider does not match the candidate');
        const name = `${model.provider}/${model.id}`;
        const evidenceScope = arm.evidenceScope ?? 'model';
        if (!['model', 'requested-system'].includes(evidenceScope))
            throw new TypeError('Invalid evidence scope');
        const optionsDigest = digest({ normalizedOptionsDigest: normalized.configDigest, evidenceScope,
            ...(outputSchemaDigest === undefined ? {} : { outputSchemaDigest }) });
        const canonical = digest({ model: name, optionsDigest });
        if (optionKeys.has(canonical))
            throw new TypeError('Duplicate canonical action');
        optionKeys.add(canonical);
        return freeze({ id: arm.id, model, options: normalized.options, optionsDigest, evidenceScope });
    });
    const auto = fixed ? undefined : definition.model as Exclude<LearningDefinition['model'], string>;
    if (auto?.fallback !== undefined && !ids.has(auto.fallback))
        throw new TypeError('Fallback outside candidate universe');
    if (c.evaluationArmId !== undefined && !ids.has(c.evaluationArmId))
        throw new TypeError('Evaluation arm outside candidate universe');
    const filters = auto === undefined ? undefined : { ...(auto.providers === undefined ? {} : { providers: auto.providers }), allowUnknownAuth: auto.allowUnknownAuth ?? false, allowUnverifiedModels: auto.allowUnverifiedModels ?? false };
    const definitionDigest = digest({ mode: fixed ? 'fixed' : 'auto', arms: arms.map(a => ({ id: a.id, model: `${a.model.provider}/${a.model.id}`, optionsDigest: a.optionsDigest })), fallback: auto?.fallback ?? null, filters: filters ?? null, featureSchema: features.schema,
        ...(outputSchemaDigest === undefined ? {} : { outputSchemaDigest }) });
    return { runtime: c.runtime, id, taskDigest: task.inputDigest, text: task.text, features: freeze(snapshot(features)), timeoutMs,
        cwd: resolve(common.cwd ?? process.cwd()), mode: fixed ? 'fixed' : 'auto', arms, definitionDigest,
        ...(outputSchema === undefined ? {} : { outputSchema: freeze(outputSchema) }),
        ...(filters === undefined ? {} : { auto: freeze(filters) }), ...(auto?.fallback === undefined ? {} : { fallbackId: auto.fallback }),
        ...(c.signal === undefined ? {} : { signal: c.signal }), ...(c.evaluationArmId === undefined ? {} : { evaluationArmId: c.evaluationArmId }) };
}
export function createScope(captured: CapturedSelection, startedAt: number): OperationScope {
    const remaining = Math.floor(captured.timeoutMs - (performance.now() - startedAt));
    if (remaining < 1)
        throw new TimeoutError({ retryable: true }, 'Learning operation deadline exceeded');
    return new OperationScope({ timeoutMs: remaining, ...(captured.signal === undefined ? {} : { signal: captured.signal }) });
}
export function assertActive(scope: OperationScope): void {
    if (scope.signal.aborted)
        throw scope.signal.reason;
    if (scope.remainingMs() < 1)
        throw new TimeoutError({ retryable: true }, 'Learning operation deadline exceeded');
}
export function safeCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || types.isProxy(error))
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor)
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : undefined;
    return undefined;
}
