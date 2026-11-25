import { realpath } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { ExecAdapter, ExecProbeContext } from '../../src/adapters/provider.js';
import type { AgentReadinessOptions, ProviderInstallation } from '../../src/public/types.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, realpath: vi.fn(original.realpath) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function fixture() {
  const adapter: ExecAdapter = {
    id: 'claude',
    detect: vi.fn(async () => ({ installed: true })),
    auth: vi.fn(async () => ({ authenticated: true, source: 'subscription' as const })),
    models: async () => [],
    execute: vi.fn(async () => ({ completed: true, failed: false, refused: false, text: 'ok', events: [], nativeEvents: [] })),
  };
  const runtime = new Runtime({ adapters: [adapter] });
  const agent = new Agent({ model: 'opus-5', transport: 'exec' }, runtime);
  return { adapter, runtime, agent };
}

describe('fresh bounded Agent readiness', () => {
  it('retries no-argument readiness after a failed preparation', async () => {
    const { agent, adapter } = fixture();
    vi.mocked(adapter.detect).mockResolvedValueOnce({ installed: false }).mockResolvedValue({ installed: true });
    await expect(agent.ready()).rejects.toMatchObject({ code: 'CLI_NOT_INSTALLED' });
    const recovered = await agent.ready();
    expect(recovered.ready).toBe(true);
    expect(await agent.ready(undefined)).toBe(recovered);
    expect(adapter.detect).toHaveBeenCalledTimes(2);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('shares one failed default attempt and one successful retry across concurrent callers', async () => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), failed = deferred<ProviderInstallation>();
    const retryStarted = deferred<void>(), retry = deferred<ProviderInstallation>();
    const failure = new Error('transient readiness failure');
    vi.mocked(adapter.detect).mockImplementationOnce(async () => { started.resolve(); return failed.promise; })
      .mockImplementationOnce(async () => { retryStarted.resolve(); return retry.promise; });
    const first = agent.ready().catch(error => error), second = agent.ready(undefined).catch(error => error);
    await started.promise;
    expect(adapter.detect).toHaveBeenCalledTimes(1);
    failed.reject(failure);
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(adapter.detect).toHaveBeenCalledTimes(1);
    const retryA = agent.ready().catch(error => error), retryB = agent.ready(undefined).catch(error => error);
    await Promise.race([retryStarted.promise, retryA, retryB]);
    retry.resolve({ installed: true });
    const [readyA, readyB] = await Promise.all([retryA, retryB]);
    expect(adapter.detect).toHaveBeenCalledTimes(2);
    expect(readyA.ready).toBe(true);
    expect(readyA).toBe(readyB);
    expect(await agent.ready()).toBe(readyA);
    expect(adapter.detect).toHaveBeenCalledTimes(2);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['ready', 'session'] as const)('shares recovered default readiness with provider session opening (%s starts first)', async first => {
    const { agent, adapter } = fixture();
    vi.mocked(adapter.detect).mockResolvedValueOnce({ installed: false }).mockResolvedValue({ installed: true });
    await expect(agent.ready()).rejects.toMatchObject({ code: 'CLI_NOT_INSTALLED' });
    const ready = first === 'ready' ? agent.ready().catch(error => error) : undefined;
    const opening = agent.openSession({ persistence: 'provider' }).catch(error => error);
    const [recovered, session] = await Promise.all([ready ?? agent.ready().catch(error => error), opening]);
    if (session instanceof Error) throw session;
    try {
      expect(recovered.ready).toBe(true);
      expect(await agent.ready()).toBe(recovered);
      expect(adapter.detect).toHaveBeenCalledTimes(2);
      expect(adapter.execute).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it('fresh failure does not evict a pending or successful default preparation', async () => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), normalProbe = deferred<ProviderInstallation>();
    const failure = new Error('fresh-only failure');
    vi.mocked(adapter.detect).mockImplementationOnce(async () => { started.resolve(); return normalProbe.promise; })
      .mockRejectedValue(failure);
    const normal = agent.ready(); await started.promise;
    await expect(agent.ready({})).rejects.toBe(failure);
    normalProbe.resolve({ installed: true });
    const cached = await normal;
    expect(await agent.ready()).toBe(cached);
    await expect(agent.ready({ timeoutMs: 1000 })).rejects.toBe(failure);
    expect(await agent.ready()).toBe(cached);
    expect(adapter.detect).toHaveBeenCalledTimes(3);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('retries with the original Agent option snapshot', async () => {
    const { runtime, adapter } = fixture();
    const options = { model: 'opus-5', transport: 'exec' as const, requireAuth: 'subscription' as const,
      environment: { mode: 'explicit' as const, variables: { READINESS_MARKER: 'original' } },
      providerOptions: { claude: { tools: ['Read'], settings: { env: { FIXTURE: 'original' } } } } };
    const agent = new Agent(options, runtime);
    vi.mocked(adapter.detect).mockResolvedValueOnce({ installed: false }).mockResolvedValue({ installed: true });
    await expect(agent.ready()).rejects.toMatchObject({ code: 'CLI_NOT_INSTALLED' });
    options.environment.variables.READINESS_MARKER = 'mutated';
    options.providerOptions.claude.tools.push('Bash');
    options.providerOptions.claude.settings.env.FIXTURE = 'mutated';
    expect((await agent.ready()).ready).toBe(true);
    expect(adapter.detect).toHaveBeenLastCalledWith(expect.objectContaining({ READINESS_MARKER: 'original' }), undefined);
    expect(adapter.auth).toHaveBeenCalledWith(expect.objectContaining({ READINESS_MARKER: 'original' }), undefined,
      expect.objectContaining({ providerOptions: { tools: ['Read'], settings: { env: { FIXTURE: 'original' } } } }));
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('fresh options remain snapshotted during default-cache recovery', async () => {
    const { agent, adapter } = fixture();
    vi.mocked(adapter.detect).mockResolvedValueOnce({ installed: false }).mockResolvedValue({ installed: true });
    await expect(agent.ready()).rejects.toMatchObject({ code: 'CLI_NOT_INSTALLED' });
    const cached = await agent.ready();
    const started = deferred<void>(), work = deferred<ProviderInstallation>();
    let context: ExecProbeContext | undefined;
    vi.mocked(adapter.detect).mockImplementation(async (_env, scope) => { context = scope; started.resolve(); return work.promise; });
    vi.mocked(adapter.auth).mockClear();
    const original = new AbortController(), replacement = new AbortController();
    const options = { timeoutMs: 1000, signal: original.signal };
    const running = agent.ready(options).catch(error => error);
    await started.promise;
    options.timeoutMs = 0; options.signal = replacement.signal;
    replacement.abort();
    expect(context?.signal.aborted).toBe(false);
    expect(context?.remainingMs()).toBeGreaterThan(0);
    original.abort(); work.resolve({ installed: true });
    expect(await running).toMatchObject({ code: 'ABORTED' });
    expect(context?.signal.aborted).toBe(true);
    expect(adapter.auth).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(await agent.ready()).toBe(cached);
  });

  it('probes again with options while preserving a successful no-argument cache', async () => {
    const { agent, adapter } = fixture();
    const cached = await agent.ready();
    adapter.auth = vi.fn(async () => ({ authenticated: true, source: 'oauth' as const }));
    const fresh = await agent.ready({ timeoutMs: 1000 });
    expect(fresh.auth.source).toBe('oauth');
    expect(await agent.ready()).toBe(cached);
    expect(fresh).not.toBe(cached);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('does not populate the no-argument readiness cache', async () => {
    const { agent, adapter } = fixture();
    const fresh = await agent.ready({});
    adapter.auth = async () => ({ authenticated: true, source: 'oauth' });
    const normal = await agent.ready();
    expect(normal.auth.source).toBe('oauth');
    expect(normal).not.toBe(fresh);
    expect(await agent.ready(undefined)).toBe(normal);
  });

  it('pre-aborted fresh readiness does not clear a successful no-argument cache', async () => {
    const { agent, adapter } = fixture();
    const normal = await agent.ready();
    const controller = new AbortController(); controller.abort();
    await expect(agent.ready({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await agent.ready()).toBe(normal);
    expect(adapter.detect).toHaveBeenCalledTimes(1);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('fresh success does not become the default cache after default failure', async () => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), normalProbe = deferred<ProviderInstallation>();
    let calls = 0;
    adapter.detect = async () => { if (++calls === 1) { started.resolve(); return normalProbe.promise; } return { installed: true }; };
    const normal = agent.ready(); await started.promise;
    const fresh = await agent.ready({ timeoutMs: 1000 });
    expect(fresh.ready).toBe(true);
    const rejected = expect(normal).rejects.toMatchObject({ code: 'CLI_NOT_INSTALLED' });
    normalProbe.resolve({ installed: false });
    await rejected;
    const recovered = await agent.ready();
    expect(recovered.ready).toBe(true);
    expect(recovered).not.toBe(fresh);
    expect(await agent.ready()).toBe(recovered);
    expect(calls).toBe(3);
  });

  it('cancelled fresh readiness neither cancels nor replaces an in-flight no-argument preparation', async () => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), normalProbe = deferred<ProviderInstallation>();
    adapter.detect = async () => { started.resolve(); return normalProbe.promise; };
    const normal = agent.ready(); await started.promise;
    const controller = new AbortController(); controller.abort();
    await expect(agent.ready({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    normalProbe.resolve({ installed: true });
    const ready = await normal;
    expect(await agent.ready()).toBe(ready);
  });

  it('failed fresh preparations can retry without poisoning subsequent normal readiness', async () => {
    const { agent, adapter } = fixture();
    adapter.detect = async () => ({ installed: false });
    await expect(agent.ready({ timeoutMs: 1000 })).rejects.toMatchObject({ code: 'CLI_NOT_INSTALLED' });
    adapter.detect = async () => ({ installed: true });
    expect((await agent.ready({ timeoutMs: 1000 })).ready).toBe(true);
    expect((await agent.ready()).ready).toBe(true);
  });

  it.each(['abort', 'timeout'] as const)('awaitSettlement drains an uncooperative detect after %s and never runs late authentication', async cause => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), work = deferred<ProviderInstallation>();
    const controller = new AbortController(); let context: ExecProbeContext | undefined;
    adapter.detect = async (_env, scope) => { context = scope; started.resolve(); return work.promise; };
    let settled = false;
    const running = agent.ready({ signal: controller.signal, timeoutMs: cause === 'timeout' ? 20 : 1000, awaitSettlement: true })
      .catch(error => error).finally(() => { settled = true; });
    await started.promise;
    if (cause === 'abort') controller.abort(); else await delay(30);
    await delay(0);
    expect(context?.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    work.resolve({ installed: true });
    expect(await running).toMatchObject({ code: cause === 'abort' ? 'ABORTED' : 'TIMEOUT' });
    expect(adapter.auth).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('awaitSettlement=%s bounds return while observing late detect rejection', async awaitSettlement => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), work = deferred<ProviderInstallation>();
    adapter.detect = async () => { started.resolve(); return work.promise; };
    const running = agent.ready({ timeoutMs: 20, ...(awaitSettlement === undefined ? {} : { awaitSettlement }) }).catch(error => error);
    await started.promise;
    expect(await running).toMatchObject({ code: 'TIMEOUT' });
    work.reject(new Error('late detect failure'));
    await delay(0);
    expect(adapter.auth).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('drains late authentication without advancing to compatibility or execution', async () => {
    const { agent, adapter } = fixture();
    const started = deferred<void>(), work = deferred<{ authenticated: boolean; source: 'subscription' }>();
    adapter.detect = async () => ({ installed: true, version: '1' });
    adapter.auth = async () => { started.resolve(); return work.promise; };
    adapter.compatibility = vi.fn(async () => undefined);
    const controller = new AbortController(); let settled = false;
    const running = agent.ready({ signal: controller.signal, timeoutMs: 1000, awaitSettlement: true })
      .catch(error => error).finally(() => { settled = true; });
    await started.promise; controller.abort(); await delay(0);
    expect(settled).toBe(false);
    work.resolve({ authenticated: true, source: 'subscription' });
    expect(await running).toMatchObject({ code: 'ABORTED' });
    expect(adapter.compatibility).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('passes derived cancellation and remaining budget to each probe', async () => {
    const { runtime, adapter } = fixture();
    const contexts: ExecProbeContext[] = [];
    adapter.detect = async (_env, scope) => { contexts.push(scope!); return { installed: true, version: '1' }; };
    adapter.auth = async (_env, scope) => { contexts.push(scope!); return { authenticated: true, source: 'subscription' }; };
    adapter.compatibility = async (_env, _version, scope) => { contexts.push(scope!); return undefined; };
    const controller = new AbortController();
    const result = await new Agent({ model: 'opus-5', transport: 'exec' }, runtime).ready({ signal: controller.signal, timeoutMs: 1000, awaitSettlement: true });
    expect(result.plan.transport).toBe('exec');
    expect(contexts).toHaveLength(3);
    expect(contexts.every(context => context === contexts[0] && context.signal !== controller.signal && context.remainingMs() <= 1000)).toBe(true);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    null, [], 3, { unexpected: true }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { timeoutMs: 2147483648 }, { timeoutMs: NaN }, { timeoutMs: null }, { timeoutMs: '2' },
    { signal: {} }, { signal: null }, { awaitSettlement: 'true' }, { awaitSettlement: null },
  ].map(options => [options]))('rejects malformed readiness options before any probe: %j', async options => {
    const { agent, adapter } = fixture();
    await expect(agent.ready(options as AgentReadinessOptions)).rejects.toThrow();
    expect(adapter.detect).not.toHaveBeenCalled();
  });

  it('rejects accessor options without invoking them', async () => {
    const { agent, adapter } = fixture(); const getter = vi.fn(() => 1000);
    await expect(agent.ready(Object.defineProperty({}, 'timeoutMs', { get: getter }) as AgentReadinessOptions)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(adapter.detect).not.toHaveBeenCalled();
  });

  it('drains every pending directory lookup after another lookup fails during cancellation', async () => {
    const { runtime, adapter } = fixture();
    const started = deferred<void>(), first = deferred<string>(), second = deferred<string>();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let pending = 0, settled = false;
    vi.mocked(realpath).mockImplementation((async (path: string) => {
      if (path === '/first' || path === '/second') {
        if (++pending === 2) started.resolve();
        return path === '/first' ? first.promise : second.promise;
      }
      return original.realpath(path);
    }) as typeof realpath);
    const controller = new AbortController();
    const agent = new Agent({ model: 'opus-5', transport: 'exec', permissions: { mode: 'analyze', additionalDirectories: ['/first', '/second'] } }, runtime);
    const running = agent.ready({ signal: controller.signal, timeoutMs: 1000, awaitSettlement: true })
      .catch(error => error).finally(() => { settled = true; });
    try {
      await started.promise; controller.abort(); first.reject(new Error('first path failed'));
      await delay(0);
      expect(settled).toBe(false);
      second.resolve('/second');
      expect(await running).toMatchObject({ code: 'ABORTED' });
      expect(adapter.detect).not.toHaveBeenCalled();
    } finally {
      second.resolve('/second');
      await running;
      vi.mocked(realpath).mockImplementation(original.realpath);
    }
  });

  it('never invokes inherited readiness-option getters', async () => {
    const { agent } = fixture();
    const getter = vi.fn(() => undefined);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'signal');
    Object.defineProperty(Object.prototype, 'signal', { configurable: true, get: getter });
    try {
      expect((await agent.ready({ timeoutMs: 1000 })).ready).toBe(true);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'signal', previous);
      else Reflect.deleteProperty(Object.prototype, 'signal');
    }
  });

  it('rejects proxy options before invoking any proxy trap', async () => {
    const { agent, adapter } = fixture();
    const get = vi.fn(), getPrototypeOf = vi.fn(() => Object.prototype), ownKeys = vi.fn(() => []);
    const options = new Proxy({}, { get, getPrototypeOf, ownKeys });
    await expect(agent.ready(options)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
    expect(adapter.detect).not.toHaveBeenCalled();
  });

  it('captures the default working directory synchronously for no-argument readiness', async () => {
    const { agent } = fixture();
    const initial = process.cwd(); let current = initial;
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => current);
    try {
      const preparing = agent.ready(); current = '/tmp';
      const readiness = await preparing;
      expect(readiness.plan.envelope.filesystem.readonlyRoots).toEqual([await realpath(initial)]);
    } finally { cwd.mockRestore(); }
  });

  it('keeps core option and authentication enforcement on the fresh path', async () => {
    const { agent, adapter } = fixture();
    adapter.auth = async () => ({ authenticated: false, source: 'unknown', state: 'not-authenticated' });
    await expect(agent.ready({ timeoutMs: 1000 })).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
