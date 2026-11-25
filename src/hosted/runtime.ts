import { Runtime } from '../core/runtime.js';
import type { RuntimeCaptureOptions } from '../orchestration/log/capture-runtime.js';
import { createClaudeProvider, createCodexProvider } from '../core/builtin-providers.js';
import { UnsupportedCapabilityError, UnknownModelError } from '../public/errors.js';
import type { ProviderRegistration } from '../core/provider-registration.js';
import type { ExecAdapter, ProcessRunner } from '../adapters/provider.js';
import type { HostedProxyFactory, HostedWorkerContext } from './types.js';
import { method, createHostedCaller } from './client.js';
import { createHostedAdapter } from './proxy.js';
import { captureHostedContext, sameTarget } from './validation.js';
import { invalid, record } from './json.js';
import { bindHostedIntentRuntime, createHostedIntentPort } from './intent.js';
const captureScopes = new WeakMap<Runtime, (capture: RuntimeCaptureOptions) => Runtime>();

/** A per-run capture scope reuses this worker's negotiated providers, transport and admission port. */
export function createHostedRunRuntime(parent: Runtime, capture: RuntimeCaptureOptions): Runtime {
    const create = captureScopes.get(parent);
    if (!create) return invalid();
    return create(capture);
}
export function createHostedRuntime(input: HostedWorkerContext, options: {
    providers?: readonly HostedProxyFactory[];
} = {}): Runtime {
    const captured = captureHostedContext(input), context = { ...captured.r, descriptors: captured.descriptors } as unknown as HostedWorkerContext;
    const intent = createHostedIntentPort(createHostedCaller(context), method(context.client, 'close')), rpc = intent.call, deny: ProcessRunner = async () => invalid();
    const factories = new Map<string, (options: {
        runner: ProcessRunner;
        probeRunner: ProcessRunner;
    }) => ProviderRegistration>([['claude', createClaudeProvider], ['codex', createCodexProvider]]);
    for (const value of options.providers ?? []) {
        const f = record(value, ['id', 'create']);
        if (typeof f.id !== 'string' || typeof f.create !== 'function' || factories.has(f.id))
            invalid();
        factories.set(f.id, f.create as HostedProxyFactory['create']);
    }
    const providers = context.descriptors.map(d => {
        const factory = factories.get(d.provider);
        if (!factory)
            invalid();
        const original = factory({ runner: deny, probeRunner: deny });
        if (original.id !== d.provider || original.exec.token !== d.token || original.exec.adapterVersion !== d.adapterVersion)
            invalid();
        let adapter: ExecAdapter;
        const proxy = createHostedAdapter(d, rpc, intent, context.dataDirectory);
        adapter = proxy.adapter;
        const registration: ProviderRegistration = { apiVersion: 1, id: d.provider, exec: { adapter, token: d.token, adapterVersion: d.adapterVersion, withTarget: target => {
                    if (!sameTarget(target, d))
                        invalid();
                    return adapter;
                } },
            modelCatalog: d.modelCatalog, execCapabilities: d.execCapabilities,
            resolveModel: nativeId => {
                const model = d.modelCatalog.find(m => m.id === nativeId);
                if (!model)
                    throw new UnknownModelError(nativeId);
                return structuredClone(model);
            },
            translateContext: requested => original.translateContext(requested), translatePermissions: (requested, transport) => {
                if (transport !== 'exec')
                    throw new UnsupportedCapabilityError({ provider: d.provider, retryable: false });
                return original.translatePermissions(requested, transport);
            },
            validateOptions: (agentOptions, transport) => {
                if (transport !== 'exec')
                    throw new UnsupportedCapabilityError({ provider: d.provider, retryable: false });
                original.validateOptions(agentOptions, transport);
                proxy.validate(agentOptions);
            } };
        return registration;
    });
    const runtime = new Runtime({ providers });
    bindHostedIntentRuntime(runtime, intent);
    captureScopes.set(runtime, capture => {
        if (capture.identity.systemId !== context.systemId || capture.identity.generation !== context.generation) return invalid();
        const scoped = new Runtime({ providers, capture });
        bindHostedIntentRuntime(scoped, intent);
        return scoped;
    });
    return runtime;
}
