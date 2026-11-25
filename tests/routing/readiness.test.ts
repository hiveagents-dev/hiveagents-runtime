import { expect, it, vi } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import type { ProviderRegistration } from '../../src/core/provider-registration.js';
import type { AuthStatus, ModelInfo } from '../../src/public/types.js';
import { createAgent, type RoutingReceipt } from '../../src/routing/index.js';
function provider(auth: AuthStatus = { authenticated: true, source: 'subscription' }, unsupported: string[] = []) {
  const catalog: ModelInfo[] = [{ id: 'NativeCase', provider: 'fixture-provider', aliases: ['fixture'], source: 'explicit', availability: 'available' }];
  const adapter = {
    id: 'fixture-provider', detect: vi.fn(async () => ({ installed: true, version: '1.0.0' })), auth: vi.fn(async () => auth),
    models: vi.fn(async () => { throw Error('dynamic discovery forbidden'); }), execute: vi.fn(async () => { throw Error('native dispatch forbidden'); }),
    compatibility: async () => ({ provider: 'fixture-provider', cliVersion: '1.0.0', transport: 'exec' as const, evidence: 'live-contract' as const, features: { turns: 'supported' as const, resume: 'supported' as const }, missingFlags: [], knownIssues: [] }),
  };
  const registration: ProviderRegistration = { apiVersion: 1, id: 'fixture-provider', exec: { adapter, token: 'fixtureExecV1', adapterVersion: '1', withTarget: () => adapter }, modelCatalog: catalog,
    resolveModel: id => ({ ...catalog[0]!, id, availability: 'unverified' }),
    translateContext: () => ({ args: [], unsupported: [], warnings: [], report: { profile: 'native', memory: 'inherit', active: [], inactive: [], unavoidable: [], unknown: [] } }),
    translatePermissions: requested => ({ args: [], report: { requested, effective: { filesystem: 'read-only', network: 'unknown', approvals: 'deny', enforcedBy: ['harness'] }, unsupported, warnings: [] } }), validateOptions: () => {},
  };
  return { runtime: new Runtime({ providers: [registration] }), adapter };
}
const receipts = { async save(_receipt: RoutingReceipt) {}, async load() { return undefined; } };
it('uses complete generic readiness for an arbitrary registered provider without a turn', async () => {
  const { runtime, adapter } = provider();
  const { agent, receipt } = await createAgent({ model: { mode: 'auto' } }, { runtime, receipts });
  expect(receipt.selected?.model).toBe('fixture-provider/NativeCase'); expect(receipt.candidates[0]?.authState).toBe('authenticated');
  expect(adapter.detect).toHaveBeenCalledOnce(); expect(adapter.auth).toHaveBeenCalledOnce(); expect(adapter.models).not.toHaveBeenCalled(); expect(adapter.execute).not.toHaveBeenCalled();
  await agent.ready(); await agent.ready(); expect(adapter.detect).toHaveBeenCalledTimes(2);
});
it('maps real negative auth and subscription enforcement to bounded codes', async () => {
  for (const [auth, requireAuth, code] of [
    [{ authenticated: true, state: 'not-authenticated', source: 'subscription' }, 'any', 'AUTH_REQUIRED'],
    [{ authenticated: true, state: 'unknown', source: 'unknown' }, 'subscription', 'AUTH_REQUIRED'],
    [{ authenticated: true, source: 'api-key' }, 'subscription', 'SUBSCRIPTION_REQUIRED'],
  ] as const) {
    const { runtime, adapter } = provider(auth);
    await expect(createAgent({ model: 'fixture', requireAuth }, { runtime, receipts })).rejects.toMatchObject({ code: 'NO_ROUTE', receipt: { candidates: [{ code }] } });
    expect(adapter.execute).not.toHaveBeenCalled();
  }
});
it('excludes real unknown auth by default in auto but allows fixed semantics', async () => {
  const { runtime } = provider({ authenticated: false, state: 'unknown', source: 'unknown' });
  await expect(createAgent({ model: { mode: 'auto' } }, { runtime, receipts })).rejects.toMatchObject({ receipt: { candidates: [{ code: 'AUTH_UNKNOWN' }] } });
  const { receipt } = await createAgent({ model: 'fixture' }, { runtime, receipts }); expect(receipt.candidates[0]?.authState).toBe('unknown');
});
it('applies strict false unsupported policy as a hard auto filter with complete readiness', async () => {
  const { runtime } = provider(undefined, ['network']);
  await expect(createAgent({ model: { mode: 'auto' }, permissions: { mode: 'analyze', strict: false } }, { runtime, receipts })).rejects.toMatchObject({ receipt: { candidates: [{ code: 'POLICY_UNSUPPORTED' }] } });
});
it('does not continue real auth preparation after an uncooperative detect settles post-abort', async () => {
  const { runtime, adapter } = provider(); let finish!: () => void; let entered!: () => void;
  const detecting = new Promise<void>(resolve => { entered = resolve; }); const settling = new Promise<void>(resolve => { finish = resolve; });
  adapter.detect.mockImplementation(async () => { entered(); await settling; return { installed: true, version: '1.0.0' }; });
  const controller = new AbortController(); let done = false;
  const pending = createAgent({ model: { mode: 'auto' } }, { runtime, receipts, signal: controller.signal }).finally(() => { done = true; });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); await detecting; controller.abort(); await Promise.resolve(); expect(done).toBe(false);
  finish(); await rejected; expect(adapter.auth).not.toHaveBeenCalled(); expect(adapter.execute).not.toHaveBeenCalled();
});
