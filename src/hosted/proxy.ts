import { isSafeSessionId, type AdapterStreamItem, type ExecAdapter, type ExecProbeContext, type ExecTurnRequest, type ProtocolResult } from '../adapters/provider.js';
import type { AuthStatus, ModelInfo, ProviderInstallation } from '../public/types.js';
import type { CliCompatibilityAssessment } from '../compatibility/manifest.js';
import type { HostedProviderDescriptor, HostedTurnPayload } from './types.js';
import type { createHostedCaller } from './client.js';
import { createRecipeMatcher } from './recipes.js';
import { absolute, id, integer, invalid, record, snapshot, strings, text } from './json.js';
import { sameTarget } from './validation.js';
import type { createHostedIntentPort } from './intent.js';
type Caller = ReturnType<typeof createHostedCaller>;
function result(value: unknown): ProtocolResult {
    const r = record(value, ['completed', 'failed', 'refused', 'sessionId', 'turnId', 'text', 'output', 'usage', 'events', 'failure', 'terminalEvent', 'nativeEvents'], ['sessionId', 'turnId', 'output', 'usage', 'failure', 'terminalEvent']);
    if (typeof r.completed !== 'boolean' || typeof r.failed !== 'boolean' || typeof r.refused !== 'boolean' || typeof r.text !== 'string' || !Array.isArray(r.events) || !Array.isArray(r.nativeEvents))
        invalid();
    if (r.sessionId !== undefined && !isSafeSessionId(r.sessionId))
        invalid();
    if (r.turnId !== undefined)
        text(r.turnId, 512);
    if (r.failure !== undefined) {
        const f = record(r.failure, ['kind', 'message', 'rawCode', 'reason', 'retryAt'], ['rawCode', 'reason', 'retryAt']);
        if (f.retryAt !== undefined && (f.kind !== 'usage-limit' || typeof f.retryAt !== 'number' || !Number.isSafeInteger(f.retryAt) || f.retryAt < 0 || f.retryAt > 8.64e15)) invalid();
        if (!['not-authenticated', 'unknown-model', 'model-unavailable', 'usage-limit', 'untrusted-workspace', 'session-not-found', 'provider-unavailable', 'protocol'].includes(f.kind as string))
            invalid();
        text(f.message, 8192);
    }
    return r as unknown as ProtocolResult;
}
function item(value: unknown): AdapterStreamItem {
    const r = record(value, ['kind', 'sessionId', 'event', 'result'], ['sessionId', 'event', 'result']);
    if (r.kind === 'session') {
        record(r, ['kind', 'sessionId']);
        if (!isSafeSessionId(r.sessionId))
            invalid();
    }
    else if (r.kind === 'event') {
        record(r, ['kind', 'event']);
        record(r.event, Object.keys(r.event as object));
    }
    else if (r.kind === 'result') {
        record(r, ['kind', 'result']);
        result(r.result);
    }
    else
        invalid();
    return r as unknown as AdapterStreamItem;
}
export function createHostedAdapter(d: HostedProviderDescriptor, call: Caller, intent: ReturnType<typeof createHostedIntentPort>, dataDirectory: string) {
    const matcher = createRecipeMatcher(d), probeMs = (c?: ExecProbeContext) => integer(Math.min(d.limits.maxProbeMs, c ? c.remainingMs() : d.limits.maxProbeMs));
    const prepare = (input: ExecTurnRequest) => {
        // Capture before asynchronous transport. Function/signal ports stay local; all wire fields are closed data.
        const r = record(input, ['mode', 'modelId', 'cwd', 'prompt', 'env', 'contextArgs', 'permissionArgs', 'timeoutMs', 'maxOutputBytes', 'awaitSettlement', 'requireSubscription', 'sessionId', 'instructions', 'effort', 'outputSchema', 'signal', 'providerOptions'], ['awaitSettlement', 'requireSubscription', 'sessionId', 'instructions', 'effort', 'outputSchema', 'signal', 'providerOptions']);
        const copied = snapshot(Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'signal'))) as unknown as ExecTurnRequest;
        const recipe = matcher.turn(copied), turn: HostedTurnPayload = { mode: copied.mode, modelId: copied.modelId, cwd: copied.cwd, prompt: copied.prompt,
            timeoutMs: Math.min(integer(copied.timeoutMs), d.limits.maxTurnMs), maxOutputBytes: Math.min(integer(copied.maxOutputBytes), d.limits.maxOutputBytes),
            ...(copied.sessionId === undefined ? {} : { sessionId: copied.sessionId }), ...(copied.instructions === undefined ? {} : { instructions: copied.instructions }), ...(copied.effort === undefined ? {} : { effort: copied.effort }), ...(copied.outputSchema === undefined ? {} : { outputSchema: copied.outputSchema as NonNullable<HostedTurnPayload['outputSchema']> }) };
        return { intent: intent.capture(), recipeId: recipe.recipeId, turn, signal: r.signal as AbortSignal | undefined, deadline: performance.now() + turn.timeoutMs };
    };
    const adapter: ExecAdapter = { id: d.provider,
        async detect(env, c) {
            matcher.probe(env);
            const raw = await call(d.bindingId, { method: 'detect', recipeId: d.probeRecipeId, cwd: dataDirectory }, probeMs(c), c?.signal);
            const r = record(raw, ['installed', 'launchTarget', 'identityFiles', 'path', 'realpath', 'version'], ['launchTarget', 'identityFiles', 'path', 'realpath', 'version']);
            if (typeof r.installed !== 'boolean')
                invalid();
            if (r.installed) {
                if (!sameTarget(r.launchTarget, d) || r.path !== d.target.command || r.realpath !== d.target.command)
                    invalid();
            }
            if (r.version !== undefined)
                text(r.version, 128);
            if (r.identityFiles !== undefined && JSON.stringify(strings(r.identityFiles)) !== JSON.stringify(d.target.identityFiles))
                invalid();
            return r as unknown as ProviderInstallation;
        },
        async auth(env, c, turn) {
            const recipe = matcher.probe(env, turn), raw = await call(d.bindingId, { method: 'auth', recipeId: recipe.recipeId, cwd: turn?.cwd ?? dataDirectory }, probeMs(c), c?.signal);
            const r = record(raw, ['authenticated', 'source', 'state', 'evidence', 'account'], ['state', 'evidence', 'account']);
            if (typeof r.authenticated !== 'boolean' || !['subscription', 'api-key', 'cloud-provider', 'oauth', 'oss', 'unknown'].includes(r.source as string))
                invalid();
            if (r.state !== undefined && !['authenticated', 'not-authenticated', 'unknown'].includes(r.state as string))
                invalid();
            if (r.evidence !== undefined && !['provider-status', 'local-configuration', 'turn-result'].includes(r.evidence as string))
                invalid();
            return r as unknown as AuthStatus;
        },
        async models() { return structuredClone(d.modelCatalog) as ModelInfo[]; },
        async compatibility(env, _version, c) {
            matcher.probe(env);
            const raw = await call(d.bindingId, { method: 'compatibility', recipeId: d.probeRecipeId, cwd: dataDirectory }, probeMs(c), c?.signal);
            const r = record(raw, ['provider', 'cliVersion', 'transport', 'evidence', 'features', 'missingFlags', 'knownIssues', 'responsePolicy'], ['responsePolicy']);
            if (r.provider !== d.provider || r.transport !== 'exec' || !['live-contract', 'help-probe', 'unverified'].includes(r.evidence as string))
                invalid();
            text(r.cliVersion, 128);
            strings(r.missingFlags);
            strings(r.knownIssues);
            const caps = record(r.features, Object.keys(r.features as object));
            for (const v of Object.values(caps))
                if (!['supported', 'partial', 'unsupported', 'unverified'].includes(v as string))
                    invalid();
            return r as unknown as CliCompatibilityAssessment;
        },
        async execute(input) { const p = prepare(input), scope = await intent.open(p.intent, d.bindingId, p.turn, p.deadline, p.signal); try {
            return result(await call(d.bindingId, { method: 'execute', recipeId: p.recipeId, turn: scope.turn }, scope.remaining(), scope.signal));
        }
        finally {
            scope.finish();
        } },
        stream(input) {
            const p = prepare(input);
            let opened: Promise<string> | undefined, pending = false, finished = false, scope: Awaited<ReturnType<typeof intent.open>> | undefined;
            const remaining = () => scope?.remaining() ?? integer(Math.ceil(p.deadline - performance.now()));
            const open = () => opened ??= (async () => { scope = await intent.open(p.intent, d.bindingId, p.turn, p.deadline, p.signal); const r = record(await call(d.bindingId, { method: 'stream-open', recipeId: p.recipeId, turn: scope.turn }, remaining(), scope.signal), ['operationId']); return id(r.operationId); })();
            const advance = async (method: 'stream-next' | 'stream-return' | 'stream-throw'): Promise<IteratorResult<AdapterStreamItem>> => {
                if (pending)
                    invalid();
                if (finished)
                    return { done: true, value: undefined };
                pending = true;
                try {
                    if (method !== 'stream-next' && !opened) {
                        finished = true;
                        scope?.finish();
                        return { done: true, value: undefined };
                    }
                    const operationId = await open(), r = record(await call(d.bindingId, { method, operationId }, remaining(), scope?.signal), ['done', 'value'], ['value']);
                    if (typeof r.done !== 'boolean')
                        invalid();
                    if (r.done) {
                        finished = true;
                        scope?.finish();
                        return { done: true, value: undefined };
                    }
                    if (method !== 'stream-next')
                        invalid();
                    return { done: false, value: item(r.value) };
                }
                catch (cause) {
                    finished = true;
                    scope?.finish();
                    throw cause;
                }
                finally {
                    pending = false;
                }
            };
            const iterator: AsyncIterableIterator<AdapterStreamItem> = { [Symbol.asyncIterator]() { return iterator; }, next: () => advance('stream-next'), return: () => advance('stream-return'), throw: () => advance('stream-throw') };
            return iterator;
        } };
    return { adapter, validate: matcher.validate };
}
