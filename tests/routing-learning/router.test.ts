import { afterEach, expect, it, vi } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import type { AgentReadiness } from '../../src/public/types.js';
import { digest } from '../../src/routing/json.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import type { EvidenceMap, LearningStore, PutKind } from '../../src/routing/learning/types.js';

const runtime = new Runtime();
const domain = { id: 'test', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
function context(text = 'ordinary task') { return { runtime, task: { id: 'task', version: '1', text, inputDigest: inputDigest(text) } }; }
function memory() {
  const rows = new Map<string, unknown>();
  const store = { async put<K extends PutKind>(kind: K, id: string, row: EvidenceMap[K]) {
    if (rows.has(`${kind}:${id}`)) throw new Error('duplicate id'); rows.set(`${kind}:${id}`, row);
  }, async get(kind: string, id: string) { return rows.get(`${kind}:${id}`); },
  async pointer() { return { generation: 0, active: null, previous: null }; }, async highWater() { return 0; },
  async observations() { return []; }, async appendObservation() { throw new Error('unused'); },
  async commitGate() { throw new Error('unused'); }, async pending() { return []; }, close() {},
  } as LearningStore;
  return { rows, store };
}
function ready(agent: Agent, epoch = 'one', version = '1'): AgentReadiness {
  return { ready: true, model: agent.model, provider: agent.model.provider,
    auth: { authenticated: true, source: 'subscription' }, installation: { installed: true },
    capabilities: { unsupported: [], transport: 'exec' },
    plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: version, executableRealpath: '/private/canary' },
      capabilities: {}, envelope: { authorityEpoch: epoch }, warnings: [] },
  } as unknown as AgentReadiness;
}
afterEach(() => vi.restoreAllMocks());
it('returns the same ordinary agent prepared for a durable fixed decision', async () => {
  const prepared: Agent[] = [];
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { prepared.push(this); return ready(this); });
  const { store, rows } = memory(); const router = new LearningRouter({ store, domain });
  const result = await router.createAgent({ model: 'codex/gpt-5.4', effort: 'high' }, { ...context(), id: 'fixed' });
  expect(result.agent).toBe(prepared[0]); expect(prepared).toHaveLength(1);
  expect(result.receipt.reason).toBe('FIXED'); expect(result.receipt.nativeDispatches).toBe(0);
  expect(rows.get('decision:fixed')).toEqual(result.receipt); expect(Object.isFrozen(result.receipt)).toBe(true);
  expect(JSON.stringify(result.receipt)).not.toContain('/private/canary');
});
it('keeps effort variants distinct and authority epochs stable', async () => {
  let counter = 0;
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return ready(this, `${counter++}`); });
  const { store } = memory(); const router = new LearningRouter({ store, domain });
  const definition = { model: { mode: 'auto' as const, allowUnverifiedModels: true, candidates: [{ id: 'low', model: 'codex/gpt-5.4', effort: 'low' }, { id: 'high', model: 'codex/gpt-5.4', effort: 'high' }] } };
  const a = await router.preflight(definition, context()); const b = await router.preflight(definition, context());
  expect(a.actions).toHaveLength(2); expect(a.actions[0]!.key).not.toBe(a.actions[1]!.key);
  expect(a.actions.map(x => x.key)).toEqual(b.actions.map(x => x.key));
  const evaluated = await router.createAgent(definition, { ...context(), evaluationArmId: 'high' });
  expect(evaluated.receipt.selected).toEqual(a.actions[1]); expect(evaluated.receipt.mode).toBe('matrix');
  expect(evaluated.receipt.definitionDigest).toBe(a.definitionDigest);
});
it('applies static filters before probes and cannot force excluded matrix arms', async () => {
  const probe = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return ready(this); });
  const { store } = memory(); const router = new LearningRouter({ store, domain });
  const definition = { model: { mode: 'auto' as const, allowUnverifiedModels: true, candidates: [{ id: 'a', model: 'codex/gpt-5.4' }, { id: 'b', model: 'claude/sonnet' }], providers: ['codex'] } };
  const result = await router.preflight(definition, context());
  expect(result.actions.map(x => x.id)).toEqual(['a']); expect(probe).toHaveBeenCalledOnce();
  await expect(router.createAgent(definition, { ...context(), evaluationArmId: 'b' })).rejects.toThrow();
  expect(probe).toHaveBeenCalledTimes(2);
});
it('rejects canonical duplicates, input digest mismatch, accessors and proxies without reading secrets', async () => {
  const { store } = memory(); const router = new LearningRouter({ store, domain });
  const probe = vi.spyOn(Agent.prototype, 'ready');
  await expect(router.preflight({ model: { mode: 'auto', candidates: [{ id: 'a', model: 'codex/gpt-5.4' }, { id: 'b', model: 'codex/gpt-5.4' }] } }, context())).rejects.toThrow(/duplicate/i);
  await expect(router.preflight({ model: 'codex/gpt-5.4' }, { ...context(), task: { ...context().task, inputDigest: digest('wrong') } })).rejects.toThrow();
  const getter = vi.fn(() => 'SECRET');
  await expect(router.preflight(Object.defineProperty({}, 'model', { enumerable: true, get: getter }) as never, context())).rejects.toThrow();
  await expect(router.preflight(new Proxy({}, { get: getter }) as never, context())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
});
it('reserves fallback last and refuses a canonical model resolution drift', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return ready(this); });
  const { store } = memory(); const router = new LearningRouter({ store, domain });
  const result = await router.createAgent({ model: { mode: 'auto', candidates: [{ id: 'fallback', model: 'codex/gpt-5.4' }, { id: 'primary', model: 'claude/sonnet' }], fallback: 'fallback', allowUnverifiedModels: true } }, context());
  expect(result.receipt.selected?.id).toBe('primary');
  const resolve = runtime.resolveModel.bind(runtime); let calls = 0;
  vi.spyOn(runtime, 'resolveModel').mockImplementation(name => { calls++; return resolve(calls % 2 ? name : 'claude/sonnet'); });
  await expect(router.createAgent({ model: 'codex/gpt-5.4' }, context())).rejects.toThrow();
});
