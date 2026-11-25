import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { createDefaultProviders } from '../../src/core/builtin-providers.js';
import type { AgentReadiness } from '../../src/public/types.js';
import { createAgent, validateRoutingReceipt, type RoutingReceipt } from '../../src/routing/index.js';
const runtime = new Runtime();
const saved: RoutingReceipt[] = [];
const receipts = { async save(r: RoutingReceipt) { saved.push(r); }, async load(id: string) { return saved.find(r => r.id === id); } };
afterEach(() => { vi.restoreAllMocks(); saved.length = 0; });
function ready(agent: Agent): AgentReadiness {
  return { ready: true, model: agent.model, provider: agent.model.provider,
    auth: { authenticated: true, source: 'subscription' }, installation: { installed: true },
    capabilities: { unsupported: [], transport: 'exec' },
    plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: '1', executableRealpath: '/private/canary' }, capabilities: {}, envelope: {}, warnings: [] },
  } as unknown as AgentReadiness;
}
function mockReady() { return vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return ready(this); }); }
it('selects and persists a fixed proposal before returning the same prepared agent', async () => {
  const probe = mockReady();
  const result = await createAgent({ model: 'codex/gpt-5.4' }, { runtime, receipts, id: 'fixed' });
  expect(result.agent.model.provider).toBe('codex'); expect(probe).toHaveBeenCalledOnce();
  expect(result.receipt).toEqual(saved[0]); expect(result.receipt.reason).toBe('FIXED');
  expect(result.receipt.nativeDispatches).toBe(0); expect(JSON.stringify(result.receipt)).not.toContain('/private/canary');
  expect(validateRoutingReceipt(result.receipt)).toEqual(result.receipt);
});
it('rejects duplicate canonical candidates before probes', async () => {
  const probe = mockReady();
  await expect(createAgent({ model: { mode: 'auto', candidates: ['codex/gpt-5.4', 'codex/gpt-5.4'] } }, { runtime, receipts })).rejects.toThrow(/duplicate/i);
  expect(probe).not.toHaveBeenCalled();
});
it('reserves fallback even when listed first and probes only primary', async () => {
  const probe = mockReady();
  const { receipt } = await createAgent({ model: { mode: 'auto', candidates: ['codex/gpt-5.4', 'claude/sonnet'], fallback: 'codex/gpt-5.4', allowUnverifiedModels: true } }, { runtime, receipts });
  expect(receipt.selected?.provider).toBe('claude'); expect(probe).toHaveBeenCalledOnce();
  expect(receipt.candidates[0]?.code).toBe('NOT_NEEDED');
});
it('refuses accessors before invoking a callback or probe', async () => {
  const getter = vi.fn(() => 'codex/gpt-5.4'); const probe = mockReady();
  await expect(createAgent(Object.defineProperty({}, 'model', { enumerable: true, get: getter }) as never, { runtime, receipts })).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
});


it('enumerates all four bundled provider catalogs without pretending unverified models are ready', async () => {
  const probe = mockReady();
  await expect(createAgent({ model: { mode: 'auto' } }, { runtime, receipts })).rejects.toMatchObject({ code: 'NO_ROUTE' });
  expect(new Set(saved[0]?.candidates.map(candidate => candidate.provider))).toEqual(
    new Set(['claude', 'codex', 'gemini', 'antigravity']),
  );
  expect(saved[0]?.candidates.every(candidate => candidate.code === 'MODEL_UNVERIFIED')).toBe(true);
  expect(probe).not.toHaveBeenCalled();
});

it('considers an added CLI beside the bundled catalogs and selects it when it is the only ready provider', async () => {
  const providers = createDefaultProviders();
  const base = providers.find(provider => provider.id === 'gemini')!;
  const id = 'example-cli';
  const catalog = { id: 'fast', provider: id, aliases: [], availability: 'available', source: 'explicit' } as const;
  const adapter: ExecAdapter = {
    id,
    detect: vi.fn(),
    auth: vi.fn(),
    models: async () => [{ ...catalog, aliases: [] }],
    execute: vi.fn(),
  };
  const extension = new Runtime({ providers: [...providers, {
    ...base, id,
    modelCatalog: [{ ...catalog, aliases: [] }],
    resolveModel: nativeId => ({ ...catalog, id: nativeId, aliases: [] }),
    exec: { ...base.exec, adapter, token: 'exampleCliExecV1', withTarget: () => adapter },
  }] });
  const probe = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) {
    const result = ready(this);
    return this.model.provider === id ? result : { ...result, auth: { authenticated: false, source: 'unknown' } };
  });
  const { agent, receipt } = await createAgent({
    model: { mode: 'auto', allowUnverifiedModels: true },
    permissions: { mode: 'analyze' },
  }, { runtime: extension, receipts });
  try {
    expect(agent.model.provider).toBe(id);
    expect(receipt.selected?.model).toBe('example-cli/fast');
    expect(receipt.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'claude', code: 'AUTH_REQUIRED' }),
      expect.objectContaining({ provider: 'codex', code: 'AUTH_REQUIRED' }),
      expect.objectContaining({ provider: 'gemini', code: 'AUTH_REQUIRED' }),
      expect.objectContaining({ provider: 'antigravity', code: 'AUTH_REQUIRED' }),
    ]));
    expect(probe).toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(receipt.nativeDispatches).toBe(0);
    expect(saved).toEqual([receipt]);
  } finally {
    await agent.close();
  }
});
