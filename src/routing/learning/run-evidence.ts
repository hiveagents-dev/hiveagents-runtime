import { types } from 'node:util';
import { resolve } from 'node:path';
import type { AgentReadiness, Turn, Usage } from '../../public/types.js';
import { freeze, ownObject, snapshot } from '../../shared/json.js';
import { usage as validateUsage } from './validation-shapes.js';
import type { LearningAction } from './types.js';
/** Freeze every verifier-visible field before the next asynchronous operation. */
export function immutableTurn(turn: Turn): Turn { return freeze(snapshot(turn)); }
/** Read only documented data descriptors, never provider getters, proxies or toJSON. */
export function turnEvidence(turn: Turn, action: LearningAction, ready: AgentReadiness, cwd: string): {
    status: Turn['status'];
    usage?: Usage;
    observedModels?: string[];
    mismatch: boolean;
} {
    const safe = ownObject(turn, ['id', 'session', 'status', 'text', 'output', 'usage', 'events', 'warnings', 'providerMetadata']);
    if (!['completed', 'refused', 'failed', 'interrupted'].includes(safe.status))
        throw new TypeError('Invalid turn status');
    const usage = safe.usage === undefined ? undefined : snapshot(safe.usage);
    if (usage !== undefined)
        validateUsage(usage);
    const observedModels = usage?.perModel === undefined ? undefined : Object.keys(usage.perModel);
    const mismatch = observedModels?.some(model => model !== action.modelId && model !== action.model) ?? false;
    const session = snapshot(safe.session);
    const preparedCwd = ready.plan.envelope.filesystem?.readonlyRoots[0] ?? cwd;
    // Session model is requested-system evidence, never proof of actual backend identity.
    const sessionMismatch = session.provider !== action.provider || session.model !== undefined && session.model !== action.modelId && session.model !== action.model
        || session.transport !== undefined && session.transport !== ready.plan.transport
        || session.cliVersion !== undefined && session.cliVersion !== ready.plan.fingerprint.cliVersion
        || session.cwd !== undefined && resolve(session.cwd) !== resolve(preparedCwd);
    return { status: safe.status, ...(usage === undefined ? {} : { usage }), ...(observedModels === undefined ? {} : { observedModels }), mismatch: action.evidenceScope === 'model' && mismatch || sessionMismatch };
}
export function errorUsage(error: unknown): Usage | undefined {
    if (!error || typeof error !== 'object' || types.isProxy(error))
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'observedUsage');
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        return undefined;
    try {
        const value = snapshot(descriptor.value) as Usage;
        validateUsage(value);
        return value;
    }
    catch {
        return undefined;
    }
}
export interface RunFailure {
    error: unknown;
}
export function combineFailure(previous: RunFailure | undefined, next: unknown): RunFailure {
    return { error: previous === undefined ? next : new AggregateError([previous.error, next], 'Learning operation and evidence/cleanup both failed') };
}
