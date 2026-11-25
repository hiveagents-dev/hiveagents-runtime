import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { ObservedTaskBudget } from '../../orchestration/tasks/index.js';
import { digest, freeze, identifier, method, ownObject, snapshot } from '../../shared/json.js';
import { captureSelection, CONTEXT_KEYS, type CapturedSelection } from './factory-context.js';
import type { LearningDefinition, LearningPolicyBinding, LearningRunContext, LearningSplit } from './types.js';
import { binding as validateBinding } from './validation-shapes.js';
export interface CapturedRun {
    selection: CapturedSelection;
    input: string;
    verify: LearningRunContext['verify'];
    acquire: ObservedTaskBudget['acquire'];
    maintenance?: NonNullable<LearningRunContext['maintenance']>;
    maintenanceTimeoutMs: number;
    split: LearningSplit;
    episodeId?: string;
    repetition?: number;
    attemptId: string;
    observationId: string;
    attemptIdProvided: boolean;
    observationIdProvided: boolean;
    expectedBinding?: LearningPolicyBinding;
}
export function captureRun(definition: LearningDefinition, context: LearningRunContext): CapturedRun {
    const c = ownObject(context, [...CONTEXT_KEYS, 'input', 'verify', 'split', 'episodeId', 'repetition', 'attemptId', 'observationId', 'budget', 'maintenance', 'maintenanceTimeoutMs', 'expectedBinding']);
    const base = Object.create(null);
    for (const key of CONTEXT_KEYS)
        if (Object.hasOwn(c, key))
            Object.defineProperty(base, key, { value: c[key], enumerable: true });
    const selection = captureSelection(definition, base);
    const expectedBinding = c.expectedBinding === undefined ? undefined : freeze(snapshot(c.expectedBinding));
    if (expectedBinding !== undefined) {
        validateBinding(expectedBinding);
        if (expectedBinding.definitionDigest !== selection.definitionDigest || digest(expectedBinding.features) !== digest({ schema: selection.features.schema, dimensions: selection.features.values.length }))
            throw new TypeError('Expected learning binding does not match the request scope or features');
    }
    if (typeof c.input !== 'string' || c.input !== selection.text)
        throw new TypeError('Executable input must equal task text');
    if (typeof c.verify !== 'function' || types.isProxy(c.verify))
        throw new TypeError('A trusted verifier is required');
    if (c.maintenance !== undefined && (typeof c.maintenance !== 'function' || types.isProxy(c.maintenance)))
        throw new TypeError('Invalid maintenance hook');
    const maintenanceTimeoutMs = c.maintenanceTimeoutMs ?? 30000;
    if (!Number.isInteger(maintenanceTimeoutMs) || maintenanceTimeoutMs < 1 || maintenanceTimeoutMs > 2147483647)
        throw new RangeError('Invalid maintenanceTimeoutMs');
    const acquire = method<ObservedTaskBudget['acquire']>(c.budget, 'acquire');
    const split = c.split ?? 'train';
    if (!['train', 'fixed', 'fresh'].includes(split))
        throw new TypeError('Invalid learning split');
    if (c.episodeId !== undefined)
        identifier(c.episodeId);
    if (split === 'train' && (c.episodeId !== undefined || c.repetition !== undefined))
        throw new TypeError('Training cannot claim heldout episode metadata');
    if (split !== 'train' && (c.episodeId === undefined || c.repetition === undefined))
        throw new TypeError('Heldout runs require a prospective episode and repetition');
    if (c.repetition !== undefined && (!Number.isSafeInteger(c.repetition) || c.repetition < 0))
        throw new TypeError('Invalid repetition');
    const attemptId = c.attemptId ?? randomUUID(), observationId = c.observationId ?? randomUUID();
    identifier(attemptId);
    identifier(observationId);
    return { selection, input: c.input, verify: c.verify, acquire, maintenanceTimeoutMs, split, attemptId, observationId, attemptIdProvided: c.attemptId !== undefined, observationIdProvided: c.observationId !== undefined,
        ...(c.episodeId === undefined ? {} : { episodeId: c.episodeId }), ...(c.repetition === undefined ? {} : { repetition: c.repetition }),
        ...(c.maintenance === undefined ? {} : { maintenance: c.maintenance }),
        ...(expectedBinding === undefined ? {} : { expectedBinding }) };
}
