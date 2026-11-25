import { isSafeSessionId } from '../adapters/provider.js';
import { validateProviderId } from '../core/provider-registration.js';
import type { HostedProviderDescriptor, HostedRecipeDescriptor, HostedReply, HostedRequest, HostedWorkerContext } from './types.js';
import { absolute, array, channelId, digest, HOSTED_BOUNDS, id, integer, invalid, record, snapshot, strings, text } from './json.js';
export function captureHostedDescriptor(input: unknown): HostedProviderDescriptor {
    const value = snapshot(input, HOSTED_BOUNDS.metadataBytes, true), r = record(value, ['schemaVersion', 'provider', 'bindingId', 'bindingDigest', 'token', 'adapterVersion', 'modelCatalog', 'execCapabilities', 'target', 'probeRecipeId', 'limits', 'recipes']);
    if (r.schemaVersion !== 1)
        invalid();
    validateProviderId(text(r.provider, 64));
    id(r.bindingId);
    digest(r.bindingDigest);
    id(r.probeRecipeId);
    if (!/^[a-zA-Z][a-zA-Z0-9]*V[1-9][0-9]*$/.test(text(r.token, 64)))
        invalid();
    text(r.adapterVersion, 128);
    const target = record(r.target, ['command', 'argsPrefix', 'executableDigest', 'identityFiles']);
    absolute(target.command);
    strings(target.argsPrefix);
    digest(target.executableDigest);
    for (const file of strings(target.identityFiles))
        absolute(file);
    const limits = record(r.limits, ['maxTurnMs', 'maxProbeMs', 'maxOutputBytes']);
    integer(limits.maxTurnMs);
    integer(limits.maxProbeMs);
    integer(limits.maxOutputBytes, 1, 64 * 1024 * 1024);
    if (!Array.isArray(r.modelCatalog) || !r.modelCatalog.length || r.modelCatalog.length > 1024 || !Array.isArray(r.recipes) || !r.recipes.length || r.recipes.length > 128)
        invalid();
    const models = new Set<string>();
    for (const model of r.modelCatalog) {
        const m = record(model, ['id', 'provider', 'aliases', 'source', 'availability', 'displayName', 'contextWindow', 'maxOutputTokens', 'supportedEffort'], ['displayName', 'contextWindow', 'maxOutputTokens', 'supportedEffort']);
        if (m.provider !== r.provider || !text(m.id, 512) || models.has(m.id as string))
            invalid();
        models.add(m.id as string);
        strings(m.aliases);
        if (!['agent-sdk', 'app-server', 'compatibility-catalog', 'explicit'].includes(m.source as string) || !['available', 'unavailable', 'unverified'].includes(m.availability as string))
            invalid();
    }
    const ids = new Set<string>();
    for (const recipe of r.recipes) {
        const p = record(recipe, ['recipeId', 'recipeDigest', 'contextArgs', 'permissionArgs', 'providerOptionsDigest', 'clientEnvironmentPolicyDigest', 'environmentPolicyId', 'modelIds', 'efforts', 'allowInstructions', 'cwdRoots']);
        const key = id(p.recipeId);
        if (ids.has(key))
            invalid();
        ids.add(key);
        digest(p.recipeDigest);
        strings(p.contextArgs);
        strings(p.permissionArgs);
        digest(p.providerOptionsDigest);
        digest(p.clientEnvironmentPolicyDigest);
        text(p.environmentPolicyId, 128);
        if (typeof p.allowInstructions !== 'boolean' || strings(p.modelIds).some(m => !models.has(m)))
            invalid();
        strings(p.efforts);
        for (const root of strings(p.cwdRoots))
            absolute(root);
    }
    if (!ids.has(r.probeRecipeId as string))
        invalid();
    const caps = record(r.execCapabilities, Object.keys(r.execCapabilities as object));
    for (const support of Object.values(caps))
        if (!['supported', 'partial', 'unsupported', 'unverified'].includes(support as string))
            invalid();
    return value as unknown as HostedProviderDescriptor;
}
export function captureHostedContext(input: HostedWorkerContext) {
    const r = record(input, ['schemaVersion', 'channelId', 'systemId', 'generation', 'dataDirectory', 'descriptors', 'client']);
    if (r.schemaVersion !== 1)
        invalid();
    channelId(r.channelId);
    text(r.systemId, 128);
    integer(r.generation);
    absolute(r.dataDirectory);
    const values = array(r.descriptors, 32);
    if (!values.length)
        invalid();
    const descriptors = values.map(captureHostedDescriptor), providers = new Set<string>(), bindings = new Set<string>();
    for (const d of descriptors) {
        if (providers.has(d.provider) || bindings.has(d.bindingId))
            invalid();
        providers.add(d.provider);
        bindings.add(d.bindingId);
    }
    return { r, descriptors: Object.freeze(descriptors) };
}
const base = ['schemaVersion', 'channelId', 'systemId', 'generation', 'bindingId', 'requestId', 'remainingMs'];
export function captureHostedRequest(input: unknown): HostedRequest {
    const method = record(input, [...base, 'method', 'recipeId', 'cwd', 'turn', 'operationId', 'targetRequestId', 'turnId', 'semanticDigest', 'intentId'], ['recipeId', 'cwd', 'turn', 'operationId', 'targetRequestId', 'turnId', 'semanticDigest', 'intentId']).method;
    const extra = ['detect', 'auth', 'models', 'compatibility'].includes(method as string) ? ['recipeId', 'cwd'] : ['execute', 'stream-open'].includes(method as string) ? ['recipeId', 'turn'] : ['stream-next', 'stream-return', 'stream-throw', 'status'].includes(method as string) ? ['operationId'] : method === 'cancel' ? ['targetRequestId'] : method === 'intent-begin' ? ['turnId', 'semanticDigest'] : method === 'intent-finish' ? ['intentId'] : invalid();
    const r = record(input, [...base, 'method', ...extra]);
    if (r.schemaVersion !== 1)
        invalid();
    channelId(r.channelId);
    text(r.systemId, 128);
    integer(r.generation);
    id(r.bindingId);
    id(r.requestId);
    integer(r.remainingMs);
    for (const k of ['recipeId', 'operationId', 'targetRequestId', 'turnId', 'intentId'])
        if (r[k] !== undefined)
            id(r[k]);
    if (r.semanticDigest !== undefined)
        digest(r.semanticDigest);
    if (r.cwd !== undefined)
        absolute(r.cwd);
    if (r.turn !== undefined) {
        const t = record(r.turn, ['mode', 'modelId', 'cwd', 'prompt', 'timeoutMs', 'maxOutputBytes', 'sessionId', 'instructions', 'effort', 'outputSchema', 'intentId', 'priority'], ['sessionId', 'instructions', 'effort', 'outputSchema', 'intentId', 'priority']);
        if (!['open', 'resume', 'fork', 'one-shot'].includes(t.mode as string))
            invalid();
        text(t.modelId, 512);
        absolute(t.cwd);
        if (typeof t.prompt !== 'string' || Buffer.byteLength(t.prompt) > HOSTED_BOUNDS.promptBytes)
            invalid();
        integer(t.timeoutMs);
        integer(t.maxOutputBytes, 1, 64 * 1024 * 1024);
        if (t.sessionId !== undefined && !isSafeSessionId(t.sessionId))
            invalid();
        if (t.outputSchema !== undefined && (t.outputSchema === null || typeof t.outputSchema !== 'object' || Array.isArray(t.outputSchema)))
            invalid();
        if (t.instructions !== undefined)
            text(t.instructions, 1024 * 1024);
        if (t.effort !== undefined)
            text(t.effort, 128);
        if (t.intentId !== undefined)
            id(t.intentId);
        // A turn may only ask to wait behind the others. No value on the wire raises it.
        if (t.priority !== undefined && t.priority !== 'low')
            invalid();
    }
    return snapshot(r, 32 * 1024 * 1024, true) as unknown as HostedRequest;
}
export function captureHostedReply(input: unknown): HostedReply {
    const r = record(input, ['schemaVersion', 'channelId', 'systemId', 'generation', 'bindingId', 'requestId', 'ok', 'data', 'error'], ['data', 'error']);
    if (r.schemaVersion !== 1)
        invalid();
    channelId(r.channelId);
    text(r.systemId, 128);
    integer(r.generation);
    id(r.bindingId);
    id(r.requestId);
    if (r.ok === true) {
        record(r, ['schemaVersion', 'channelId', 'systemId', 'generation', 'bindingId', 'requestId', 'ok', 'data']);
    }
    else if (r.ok === false) {
        record(r, ['schemaVersion', 'channelId', 'systemId', 'generation', 'bindingId', 'requestId', 'ok', 'error']);
        const e = record(r.error, ['code', 'receiptDigest', 'reason'], ['receiptDigest', 'reason']);
        if (!['ADMISSION_REFUSED', 'EXECUTION_HALTED', 'USAGE_LIMIT', 'UNSUPPORTED_CAPABILITY', 'INVALID_RUNTIME_PROTOCOL', 'ABORTED', 'TIMEOUT', 'OUTPUT_LIMIT', 'PROVIDER_UNAVAILABLE', 'NOT_AUTHENTICATED'].includes(e.code as string))
            invalid();
        if (e.code === 'ADMISSION_REFUSED') {
            record(e, ['code', 'reason', 'receiptDigest']);
            digest(e.receiptDigest);
            if (!['concurrency-limit', 'hourly-limit', 'daily-limit', 'quota-cooldown', 'wait-timeout'].includes(e.reason as string))
                invalid();
        }
        else
            record(e, ['code', 'receiptDigest'], ['receiptDigest']);
        if (e.receiptDigest !== undefined)
            digest(e.receiptDigest);
    }
    else
        invalid();
    return snapshot(r) as unknown as HostedReply;
}
export function sameTarget(value: unknown, d: HostedProviderDescriptor): boolean { const r = record(value, ['command', 'argsPrefix']); return r.command === d.target.command && JSON.stringify(strings(r.argsPrefix)) === JSON.stringify(d.target.argsPrefix); }
export function recipeById(d: HostedProviderDescriptor, id: string): HostedRecipeDescriptor {
    const found = d.recipes.find(r => r.recipeId === id);
    if (!found)
        invalid();
    return found;
}
