import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { ProviderRegistration } from '../../src/core/provider-registration.js';
import type { AgentReadiness, ModelInfo } from '../../src/public/types.js';
import { createAgent, RoutingSelectionError, type RoutingReceipt } from '../../src/routing/index.js';
const model = (id: string, availability: ModelInfo['availability'] = 'available'): ModelInfo => ({ id, provider: 'custom', aliases: id === 'first' ? ['alias'] : [], source: 'explicit', availability });
function registration(): ProviderRegistration {
  return { apiVersion: 1, id: 'custom', exec: { adapter: { id: 'custom', models: vi.fn(() => { throw Error('dynamic discovery forbidden'); }) }, token: 'customV1', adapterVersion: '1', withTarget: vi.fn() },
    modelCatalog: [model('first'), model('second'), model('unknown', 'unverified'), model('gone', 'unavailable')],
    resolveModel(id: string) { if (id === 'explicit') return model(id, 'unverified'); throw Error('unknown'); },
    translateContext: vi.fn(), translatePermissions: vi.fn(), validateOptions: vi.fn(),
  } as unknown as ProviderRegistration;
}
const runtime = new Runtime({ providers: [registration()] });
const saved: RoutingReceipt[] = [];
const receipts = { async save(r: RoutingReceipt) { saved.push(r); }, async load() { return undefined; } };
function readiness(agent: Agent, state = 'authenticated', unsupported: string[] = []): AgentReadiness {
  return { ready: true, model: agent.model, provider: agent.model.provider, installation: { installed: true },
    auth: { authenticated: state === 'authenticated', state, source: state === 'unknown' ? 'unknown' : 'subscription' },
    capabilities: { unsupported }, plan: { transport: 'exec', fingerprint: { executableRealpath: '/secret' }, capabilities: {}, envelope: {}, warnings: [] },
  } as unknown as AgentReadiness;
}
function probe() { return vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this); }); }
afterEach(() => { vi.restoreAllMocks(); saved.length = 0; });
it('discovers a custom synchronous catalog and never calls dynamic models', async () => {
  const p = probe(); const discovery = vi.spyOn(runtime, 'models');
  const { receipt, agent } = await createAgent({ model: { mode: 'auto' } }, { runtime, receipts });
  expect(agent.model.id).toBe('first'); expect(p).toHaveBeenCalledOnce(); expect(discovery).not.toHaveBeenCalled();
  expect(receipt.candidates.map(c => c.code)).toEqual(['READY', 'NOT_NEEDED', 'MODEL_UNVERIFIED', 'MODEL_UNAVAILABLE']);
  expect(p.mock.calls[0]?.[0]).toMatchObject({ awaitSettlement: true, signal: expect.any(AbortSignal) });
});
it('canonicalizes aliases and rejects canonical duplicates and unknown references before probes', async () => {
  const p = probe();
  for (const auto of [
    { mode: 'auto', candidates: ['custom/first', 'alias'] },
    { mode: 'auto', candidates: ['custom/first'], fallback: 'custom/second' },
    { mode: 'auto', candidates: ['custom/first'], providers: ['absent'] },
    { mode: 'auto', candidates: ['custom/first'], rules: [{ id: 'r', allTags: ['x'], models: ['custom/second'] }] },
    { mode: 'auto', candidates: ['custom/first'], rules: [{ id: 'r', allTags: ['x', 'x'], models: ['custom/first'] }] },
  ] as const) await expect(createAgent({ model: auto }, { runtime, receipts })).rejects.toThrow();
  expect(p).not.toHaveBeenCalled();
});
it('uses first matching rule, exact case sensitive tags and task snapshots', async () => {
  probe();
  const { receipt } = await createAgent({ model: { mode: 'auto', candidates: ['custom/first', 'custom/second'], rules: [
    { id: 'upper', allTags: ['X'], models: ['custom/first'] }, { id: 'lower', allTags: ['x'], models: ['custom/second'] },
  ] } }, { runtime, receipts, task: { id: 'task', version: '1', inputDigest: 'a'.repeat(64), tags: ['x'] } });
  expect(receipt.policy.ruleId).toBe('lower'); expect(receipt.selected?.modelId).toBe('second'); expect(receipt.candidates[0]?.code).toBe('NOT_IN_RULE');
  expect(JSON.stringify(receipt)).not.toContain('inputDigest');
});
it('abstains without a matching rule and probes explicit fallback when configured', async () => {
  const p = probe(); const base = { mode: 'auto' as const, candidates: ['custom/first', 'custom/second'], rules: [{ id: 'r', allTags: ['x'], models: ['custom/first'] }] };
  await expect(createAgent({ model: base }, { runtime, receipts })).rejects.toMatchObject({ code: 'NO_ROUTE', receipt: { reason: 'NO_MATCHING_RULE' } });
  expect(p).not.toHaveBeenCalled();
  const { receipt } = await createAgent({ model: { ...base, fallback: 'custom/second' } }, { runtime, receipts });
  expect(receipt.reason).toBe('FALLBACK'); expect(p).toHaveBeenCalledOnce();
});
it('never widens hard provider, availability or unknown auth filters', async () => {
  const p = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this, 'unknown'); });
  await expect(createAgent({ model: { mode: 'auto', candidates: ['custom/first', 'custom/unknown', 'custom/gone'], providers: [] } }, { runtime, receipts })).rejects.toBeInstanceOf(RoutingSelectionError);
  expect(p).not.toHaveBeenCalled();
  await expect(createAgent({ model: { mode: 'auto', candidates: ['custom/first'] } }, { runtime, receipts })).rejects.toMatchObject({ receipt: { candidates: [{ code: 'AUTH_UNKNOWN' }] } });
  const { receipt } = await createAgent({ model: { mode: 'auto', candidates: ['custom/unknown'], allowUnverifiedModels: true, allowUnknownAuth: true } }, { runtime, receipts });
  expect(receipt.selected?.modelId).toBe('unknown');
  await expect(createAgent({ model: { mode: 'auto', candidates: ['custom/gone'], allowUnverifiedModels: true } }, { runtime, receipts })).rejects.toMatchObject({ receipt: { candidates: [{ code: 'MODEL_UNAVAILABLE' }] } });
});
it('excludes explicit negative auth even when unknown auth is permitted', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this, 'not-authenticated'); });
  await expect(createAgent({ model: { mode: 'auto', candidates: ['custom/first'], allowUnknownAuth: true } }, { runtime, receipts })).rejects.toMatchObject({ receipt: { candidates: [{ code: 'AUTH_REQUIRED' }] } });
});
it('rejects unsupported policy even with strict false and never broadens it', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this, 'authenticated', ['network']); });
  await expect(createAgent({ model: { mode: 'auto', candidates: ['custom/first'] }, permissions: { mode: 'analyze', strict: false, network: 'deny' } }, { runtime, receipts })).rejects.toMatchObject({ receipt: { candidates: [{ code: 'POLICY_UNSUPPORTED' }] } });
});
it('allows fixed explicit unverified models and unknown authentication', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this, 'unknown'); });
  const { receipt } = await createAgent({ model: 'custom/explicit' }, { runtime, receipts });
  expect(receipt.selected?.modelId).toBe('explicit'); expect(receipt.candidates[0]?.authState).toBe('unknown');
});
it('persists empty universe abstention without probes', async () => {
  const p = probe(); await expect(createAgent({ model: { mode: 'auto', candidates: [] } }, { runtime, receipts })).rejects.toMatchObject({ code: 'NO_ROUTE', receipt: { reason: 'NO_CANDIDATES' } }); expect(p).not.toHaveBeenCalled();
});
