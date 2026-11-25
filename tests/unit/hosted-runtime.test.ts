import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RUNTIME_ADAPTER_VERSION } from '../../src/core/registry.js';
import { Agent, Runtime, isExecutionHalted, AdmissionRefusedError, UsageLimitError, AbortError, TimeoutError, OutputLimitError, UnsupportedCapabilityError, ProviderUnavailableError, NotAuthenticatedError } from '../../src/index.js';
import { captureHostedRequest, createHostedRuntime, hostedDigest, type HostedProviderDescriptor, type HostedRequest, type HostedReply } from '../../src/hosted-runtime.js';
// Protocol-only worker fixture. Synthetic auth/results prove no Host admission or provider authentication.
export function fixture() {
    const probeRecipeId = randomUUID();
    const provider: HostedProviderDescriptor = { schemaVersion: 1, provider: 'claude', bindingId: randomUUID(), bindingDigest: 'a'.repeat(64), token: 'claudeExecV1', adapterVersion: RUNTIME_ADAPTER_VERSION,
        modelCatalog: [{ id: 'claude-test', provider: 'claude', aliases: ['test'], source: 'explicit', availability: 'available' }], execCapabilities: { tokenDeltas: 'unverified' },
        target: { command: realpathSync(process.execPath), argsPrefix: [], executableDigest: 'b'.repeat(64), identityFiles: [] }, probeRecipeId,
        limits: { maxTurnMs: 600000, maxProbeMs: 30000, maxOutputBytes: 64 * 1024 * 1024 }, recipes: [{ recipeId: probeRecipeId, recipeDigest: 'c'.repeat(64), contextArgs: [], permissionArgs: ['--permission-mode', 'plan'], providerOptionsDigest: hostedDigest({}), clientEnvironmentPolicyDigest: hostedDigest({ mode: 'inherit' }), environmentPolicyId: 'fixture-account', modelIds: ['claude-test'], efforts: [], allowInstructions: false, cwdRoots: [realpathSync(tmpdir())] }] };
    const requests: HostedRequest[] = [], context = { schemaVersion: 1 as const, channelId: randomUUID().replaceAll('-', ''), systemId: 'fixture', generation: 1, dataDirectory: realpathSync(tmpdir()), descriptors: [provider], client: {
            async call(request: HostedRequest): Promise<HostedReply> {
                requests.push(request);
                const base = { schemaVersion: 1 as const, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId };
                const result = { completed: true, failed: false, refused: false, sessionId: 'owned-session', text: 'synthetic answer', events: [], nativeEvents: [] };
                const data = request.method === 'detect' ? { installed: true, path: provider.target.command, realpath: provider.target.command, launchTarget: { command: provider.target.command, argsPrefix: [] }, version: 'synthetic-1' }
                    : request.method === 'auth' ? { authenticated: true, source: 'subscription', state: 'authenticated', evidence: 'provider-status' }
                        : request.method === 'compatibility' ? { provider: 'claude', cliVersion: 'synthetic-1', transport: 'exec', evidence: 'help-probe', features: { turns: 'supported', resume: 'supported', forkWithPrompt: 'supported' }, missingFlags: [], knownIssues: [] }
                            : request.method === 'models' ? provider.modelCatalog : request.method === 'execute' ? result : { operationId: randomUUID() };
                return { ...base, ok: true, data } as HostedReply;
            }, close() { }
        } };
    return { provider, context, requests };
}
describe('closed hosted Runtime proxy foundation', () => {
    it('constructs the actual SDK Runtime with only descriptor providers and no control transport', () => {
        const f = fixture(), runtime = createHostedRuntime(f.context);
        expect(runtime).toBeInstanceOf(Runtime);
        expect(runtime.providers()).toEqual(['claude']);
        expect(runtime.controlRegistration('claude')).toBeUndefined();
        expect(f.requests).toHaveLength(0);
    });
    it('runs a real Agent over protocol-only proxies without forwarding target/env/argv/lease fields', async () => {
        const f = fixture(), runtime = createHostedRuntime(f.context), agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec', requireAuth: 'subscription' }, runtime);
        const result = await agent.send('private prompt');
        expect(result.text).toBe('synthetic answer');
        expect(f.requests.some(r => r.method === 'execute')).toBe(true);
        for (const request of f.requests) {
            const text = JSON.stringify(request);
            for (const forbidden of ['"env"', '"command"', '"args"', '"contextArgs"', '"permissionArgs"', '"probeFlag"', '"lease"'])
                expect(text).not.toContain(forbidden);
        }
    });
    it('rejects arbitrary withTarget and control requirements before any client call', async () => {
        const f = fixture(), runtime = createHostedRuntime(f.context);
        expect(() => runtime.adapterWithTarget('claude', { command: '/arbitrary', argsPrefix: [] })).toThrow();
        const agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'control' }, runtime);
        await expect(agent.ready()).rejects.toThrow();
        expect(f.requests).toHaveLength(0);
    });
    it('rejects descriptor getters/proxies without invoking hooks or installing default providers', () => {
        const f = fixture();
        let traps = 0;
        const descriptor = new Proxy(f.provider, { get() { traps++; throw Error('forbidden'); } });
        expect(() => createHostedRuntime({ ...f.context, descriptors: [descriptor] })).toThrow();
        expect(traps).toBe(0);
        expect(f.requests).toHaveLength(0);
    });
    it('reconstructs nominal UNKNOWN and never falls back to a default Runtime', async () => {
        const f = fixture();
        f.context.client.call = async (request) => ({ schemaVersion: 1, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId, ok: false, error: { code: 'EXECUTION_HALTED' } });
        const runtime = createHostedRuntime(f.context), agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, runtime);
        await expect(agent.ready()).rejects.toSatisfy(isExecutionHalted);
        expect(runtime.providers()).toEqual(['claude']);
    });
});
// The production change these catch is admitting accessor-bearing containers or altered authority data.
describe('hosted proxy capture boundaries', () => {
    it('does not invoke descriptor array accessors', () => {
        const f = fixture();
        let calls = 0;
        const descriptors = [] as HostedProviderDescriptor[];
        Object.defineProperty(descriptors, '0', { get() { calls++; return f.provider; }, enumerable: true });
        expect(() => createHostedRuntime({ ...f.context, descriptors })).toThrow();
        expect(calls).toBe(0);
    });
    it('does not invoke target prefix array accessors', () => {
        const f = fixture(), runtime = createHostedRuntime(f.context);
        let calls = 0;
        const args = [] as string[];
        Object.defineProperty(args, '0', { get() { calls++; return ''; }, enumerable: true });
        expect(() => runtime.adapterWithTarget('claude', { command: f.provider.target.command, argsPrefix: args })).toThrow();
        expect(calls).toBe(0);
    });
    it('captures descriptors and client method references before caller mutation', async () => {
        const f = fixture(), runtime = createHostedRuntime(f.context);
        f.context.client.call = async () => { throw Error('changed'); };
        (f.provider.target as {
            command: string;
        }).command = '/changed';
        const agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, runtime);
        // This fixture call reads f.provider too: restoring that public fixture is unrelated to the already captured proxy.
        (f.provider.target as {
            command: string;
        }).command = realpathSync(process.execPath);
        expect((await agent.send('x')).text).toBe('synthetic answer');
    });
    it('rejects an unapproved environment locally with no RPC', async () => {
        const f = fixture(), runtime = createHostedRuntime(f.context), agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec', environment: { mode: 'inherit', variables: { NODE_OPTIONS: '--inspect' } } }, runtime);
        await expect(agent.ready()).rejects.toSatisfy(isExecutionHalted);
        expect(f.requests).toHaveLength(0);
    });
    it('rejects wrong reply binding nominally and closes the transport once', async () => {
        const f = fixture();
        let closed = 0;
        const original = f.context.client.call;
        f.context.client.close = () => { closed++; };
        f.context.client.call = async (request) => ({ ...await original(request), bindingId: randomUUID() });
        const runtime = createHostedRuntime(f.context), agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, runtime);
        await expect(agent.ready()).rejects.toSatisfy(isExecutionHalted);
        expect(closed).toBe(1);
    });
});
describe('hosted closed turn and stream messages', () => {
    const header = () => ({ schemaVersion: 1, channelId: randomUUID().replaceAll('-', ''), systemId: 'fixture', generation: 1, bindingId: randomUUID(), requestId: randomUUID(), remainingMs: 1000, method: 'execute', recipeId: randomUUID(), turn: { mode: 'open', modelId: 'claude-test', cwd: realpathSync(tmpdir()), prompt: 'x', timeoutMs: 1000, maxOutputBytes: 1000 } });
    it('rejects transcript selectors and non-object output schemas', () => {
        const input = header();
        expect(() => captureHostedRequest({ ...input, turn: { ...input.turn, sessionId: 'secret.jsonl' } })).toThrow();
        expect(() => captureHostedRequest({ ...input, turn: { ...input.turn, outputSchema: 7 } })).toThrow();
    });
    it('transmits ordered semantic stream items through a real Agent', async () => {
        const f = fixture(), original = f.context.client.call;
        let index = 0;
        const operationId = randomUUID();
        f.context.client.call = async (request) => {
            const base = { schemaVersion: 1 as const, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId };
            if (request.method === 'stream-open')
                return { ...base, ok: true, data: { operationId } };
            if (request.method === 'stream-next') {
                const items = [{ kind: 'session', sessionId: 'owned-session' }, { kind: 'result', result: { completed: true, failed: false, refused: false, sessionId: 'owned-session', text: 'stream answer', events: [], nativeEvents: [] } }];
                return { ...base, ok: true, data: index < items.length ? { done: false, value: items[index++]! } : { done: true } } as HostedReply;
            }
            if (request.method === 'stream-return')
                return { ...base, ok: true, data: { done: true } };
            return original(request);
        };
        const agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, createHostedRuntime(f.context));
        for await (const _ of agent.stream('x')) { }
        expect(index).toBe(2);
    });
});
describe('hosted errors retain the SDK nominal policy classes', () => {
    it.each([['USAGE_LIMIT', UsageLimitError], ['ABORTED', AbortError], ['TIMEOUT', TimeoutError], ['OUTPUT_LIMIT', OutputLimitError], ['UNSUPPORTED_CAPABILITY', UnsupportedCapabilityError], ['PROVIDER_UNAVAILABLE', ProviderUnavailableError], ['NOT_AUTHENTICATED', NotAuthenticatedError]] as const)('reconstructs %s from a closed reply through actual Agent readiness', async (code, Constructor) => {
        const f = fixture();
        f.context.client.call = async (request) => ({ schemaVersion: 1, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId, ok: false, error: { code } } as HostedReply);
        const agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, createHostedRuntime(f.context));
        await expect(agent.ready()).rejects.toBeInstanceOf(Constructor);
    });
});
describe('existing 10A channel binding format', () => {
    it('accepts the exact 32-hex channel ID used by the one-Duplex transport', () => { const f = fixture(); expect(() => createHostedRuntime({ ...f.context, channelId: 'a'.repeat(32) })).not.toThrow(); });
});
describe('definitive admission refusal wire classification', () => {
    it('reconstructs capacity refusal as its own nominal error, with no provider-usage relabel', async () => {
        const f = fixture();
        f.context.client.call = async (request) => ({ schemaVersion: 1, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId, ok: false, error: { code: 'ADMISSION_REFUSED', reason: 'concurrency-limit', receiptDigest: 'd'.repeat(64) } } as unknown as HostedReply);
        const agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, createHostedRuntime(f.context));
        await expect(agent.ready()).rejects.toBeInstanceOf(AdmissionRefusedError);
    });
});
it('malformed admission refusal receipts remain nominal protocol halts', async () => { const f = fixture(); f.context.client.call = async (request) => ({ schemaVersion: 1, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId, ok: false, error: { code: 'ADMISSION_REFUSED', reason: 'daily-limit', receiptDigest: undefined } } as unknown as HostedReply); const agent = new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, createHostedRuntime(f.context)); await expect(agent.ready()).rejects.toSatisfy(isExecutionHalted); });
