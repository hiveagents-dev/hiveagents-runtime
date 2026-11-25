import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { ProviderRegistration } from '../../src/core/provider-registration.js';
import type { AgentReadiness, ModelInfo } from '../../src/public/types.js';
import { createAgent, validateRoutingReceipt, type RoutingReceipt } from '../../src/routing/index.js';
import { digest } from '../../src/routing/json.js';
const model = (id = 'first', availability: unknown = 'available'): ModelInfo => ({ id, provider: 'dummy', aliases: [], availability, source: 'explicit' }) as ModelInfo;
function runtime(resolveModel: (name: string) => ModelInfo = name => model(name)) {
  const adapter = { id: 'dummy' };
  return new Runtime({ providers: [{ apiVersion: 1, id: 'dummy', modelCatalog: [], resolveModel,
    exec: { adapter, token: 'dummyV1', adapterVersion: '1', withTarget: () => adapter },
  } as unknown as ProviderRegistration] });
}
function readiness(agent: Agent): AgentReadiness { return { ready: true, model: agent.model, provider: agent.model.provider,
  installation: { installed: true }, auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] },
  plan: { transport: 'exec', fingerprint: {}, capabilities: {}, envelope: {}, warnings: [] },
} as unknown as AgentReadiness; }
function probe() { return vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this); }); }
const receipts = { async save(_r: RoutingReceipt) {}, async load() { return undefined; } };
afterEach(() => vi.restoreAllMocks());
it('rejects a constructed Agent resolving outside the snapshotted candidate universe', async () => {
  const p = probe(); const r = runtime(name => name === 'alias' ? model('A') : model('B', 'unavailable'));
  await expect(createAgent({ model: { mode: 'auto', candidates: ['dummy/alias'] } }, { runtime: r, receipts })).rejects.toMatchObject({ code: 'NO_ROUTE' });
  expect(p).not.toHaveBeenCalled();
});
it('rejects prepared identity or availability drift and malformed model availability', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return { ...readiness(this), model: model('outside') }; });
  await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts })).rejects.toMatchObject({ code: 'NO_ROUTE' });
  const p = vi.mocked(Agent.prototype.ready); p.mockClear();
  for (const availability of ['invalid', null, undefined]) {
    const bad = model(); (bad as unknown as Record<string, unknown>).availability = availability;
    await expect(createAgent({ model: { mode: 'auto', candidates: ['dummy/first'] } }, { runtime: runtime(() => bad), receipts })).rejects.toThrow(/availability/);
  }
  expect(p).not.toHaveBeenCalled();
});
it('includes synchronous normalization in the selection deadline before any probe', async () => {
  const p = probe(); const r = runtime(name => { const until = performance.now() + 45; while (performance.now() < until) {} return model(name); });
  await expect(createAgent({ model: 'dummy/first' }, { runtime: r, receipts, timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT', receipt: { reason: 'TIMEOUT' } });
  expect(p).not.toHaveBeenCalled();
});
it('checks cancellation synchronously after the final awaited work', async () => {
  probe(); const controller = new AbortController();
  const store = { ...receipts, async save() { queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort()))); } };
  await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts: store, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', receipt: { decision: 'selected' } });
});
it('checks elapsed deadline synchronously after the final awaited work', async () => {
  probe(); const store = { ...receipts, async save() { queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { const until = performance.now() + 60; while (performance.now() < until) {} }))); } };
  await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts: store, timeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT', receipt: { decision: 'selected' } });
});
it('supports repeated valid tool schemas with $id without invoking callbacks', async () => {
  const p = probe(); const authorize = vi.fn(() => true); const execute = vi.fn();
  const definition = { model: 'dummy/first', transport: 'control' as const, providerOptions: { experimentalControl: true, experimentalApi: true },
    tools: [{ name: 'fixture', description: 'fixture', inputSchema: { $id: 'https://example.test/routing-schema', type: 'object' }, timeoutMs: 30, maxOutputBytes: 1024, authorize, execute }] };
  for (let i = 0; i < 2; i++) await expect(createAgent(definition, { runtime: runtime(), receipts })).resolves.toMatchObject({ receipt: { decision: 'selected' } });
  expect(p).toHaveBeenCalledTimes(2); expect(authorize).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});
it('rejects factory-unreachable receipt semantics even with recomputed hashes', () => {
  const base = { format: 1, purpose: 'selection-proposal', id: 'semantic', createdAt: 1, configDigest: 'a'.repeat(64), taskDigest: 'b'.repeat(64), policy: { mode: 'auto', version: 'priority-v1' },
    decision: 'selected', reason: 'PRIORITY', candidates: [{ model: 'dummy/first', provider: 'dummy', modelId: 'first', status: 'eligible', code: 'READY', transport: 'exec', fingerprintDigest: 'c'.repeat(64) }],
    selected: { model: 'dummy/first', provider: 'dummy', modelId: 'first', transport: 'exec', fingerprintDigest: 'c'.repeat(64) }, nativeDispatches: 0 };
  for (const body of [
    { ...base, candidates: [{ ...base.candidates[0], authState: 'not-authenticated' }] },
    { ...base, policy: { ...base.policy, ruleId: 'matched' } },
    { ...base, policy: { mode: 'fixed', version: 'priority-v1' }, candidates: [], selected: undefined, decision: 'abstained', reason: 'NO_MATCHING_RULE' },
    { ...base, candidates: [], selected: undefined, decision: 'abstained', reason: 'NO_ELIGIBLE_CANDIDATE' },
    { ...base, policy: { mode: 'fixed', version: 'priority-v1' }, candidates: [{ ...base.candidates[0], status: 'not-evaluated', code: 'NOT_IN_RULE' }], selected: undefined, decision: 'abstained', reason: 'ABORTED' },
  ]) {
    const clean = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    expect(() => validateRoutingReceipt({ ...clean, digest: digest(clean) })).toThrow();
  }
});
it('maps arbitrary probe error codes to PROBE_FAILED and still persists the proposal', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockRejectedValue({ code: 'constructor' }); const saved: RoutingReceipt[] = [];
  await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts: { ...receipts, async save(r) { saved.push(r); } } })).rejects.toMatchObject({ code: 'NO_ROUTE', receipt: { candidates: [{ code: 'PROBE_FAILED' }] } });
  expect(saved).toHaveLength(1);
});
it('rejects explicit null context fields rather than choosing defaults', async () => {
  const p = probe();
  for (const extra of [{ id: null }, { timeoutMs: null }]) await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts, ...extra } as never)).rejects.toThrow();
  expect(p).not.toHaveBeenCalled();
});
it('rejects same-ID availability drift both during construction and readiness', async () => {
  const p = probe(); let count = 0;
  const changing = runtime(name => model(name, ++count === 1 ? 'available' : 'unverified'));
  await expect(createAgent({ model: { mode: 'auto', candidates: ['dummy/first'], allowUnverifiedModels: true } }, { runtime: changing, receipts })).rejects.toMatchObject({ code: 'NO_ROUTE' });
  expect(p).not.toHaveBeenCalled();
  p.mockImplementation(async function(this: Agent) { return { ...readiness(this), model: model(this.model.id, 'unavailable') }; });
  await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts })).rejects.toMatchObject({ code: 'NO_ROUTE' });
});
it('never returns an Agent whose model was changed while the receipt sink awaited', async () => {
  let prepared: Agent | undefined;
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { prepared = this; return readiness(this); });
  const store = { ...receipts, async save() { prepared!.model.id = 'mutated'; } };
  await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts: store })).rejects.toMatchObject({ code: 'NO_ROUTE', receipt: { decision: 'selected' } });
});
function abstention(mode: 'fixed' | 'auto', reason: string, code: string) {
  const body = { format: 1, purpose: 'selection-proposal', id: 'abstention', createdAt: 1,
    configDigest: 'a'.repeat(64), taskDigest: 'b'.repeat(64), policy: { mode, version: 'priority-v1' },
    decision: 'abstained', reason, nativeDispatches: 0,
    candidates: [{ model: 'dummy/first', provider: 'dummy', modelId: 'first', status: 'excluded', code }] };
  return { ...body, digest: digest(body) };
}
it('rejects checksummed no-matching-rule proposals claiming a probe failure', () => {
  expect(() => validateRoutingReceipt(abstention('auto', 'NO_MATCHING_RULE', 'PROBE_FAILED'))).toThrow();
  for (const code of ['PROVIDER_NOT_ALLOWED', 'MODEL_UNAVAILABLE', 'MODEL_UNVERIFIED']) {
    expect(() => validateRoutingReceipt(abstention('auto', 'NO_MATCHING_RULE', code))).not.toThrow();
  }
});
it('rejects checksummed fixed proposals with automatic-only exclusion codes', () => {
  for (const code of ['PROVIDER_NOT_ALLOWED', 'MODEL_UNVERIFIED', 'AUTH_UNKNOWN']) {
    expect(() => validateRoutingReceipt(abstention('fixed', 'NO_ELIGIBLE_CANDIDATE', code))).toThrow();
  }
});

it('never evaluates hostile probe exception getters or proxy traps and persists fallback proposals', async () => {
  const canary = 'CANARY_RAW_PROBE_SECRET';
  let gets = 0, traps = 0;
  const accessor = Object.defineProperty({}, 'code', { get() { gets++; throw new Error(canary); } });
  const proxy = new Proxy({}, { get() { traps++; throw new Error(canary); },
    getOwnPropertyDescriptor() { traps++; throw new Error(canary); }, getPrototypeOf() { traps++; throw new Error(canary); } });
  for (const error of [accessor, proxy]) {
    vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) {
      if (this.model.id === 'first') throw error;
      return readiness(this);
    });
    const saved: RoutingReceipt[] = [];
    const result = await createAgent({ model: { mode: 'auto', candidates: ['dummy/first', 'dummy/fallback'], fallback: 'dummy/fallback' } },
      { runtime: runtime(), receipts: { ...receipts, async save(receipt) { saved.push(receipt); } } });
    expect(result.receipt.reason).toBe('FALLBACK');
    expect(result.receipt.candidates[0]?.code).toBe('PROBE_FAILED');
    expect(saved).toEqual([result.receipt]);
    expect(JSON.stringify(saved)).not.toContain(canary);
    vi.restoreAllMocks();
  }
  expect(gets).toBe(0); expect(traps).toBe(0);
});
it('preserves symbolic mappings for ordinary own data error codes', async () => {
  for (const [code, expected] of [['CLI_NOT_INSTALLED', 'CLI_MISSING'], ['NOT_AUTHENTICATED', 'AUTH_REQUIRED'],
    ['UNEXPECTED_AUTH_SOURCE', 'SUBSCRIPTION_REQUIRED'], ['UNSUPPORTED_CLI_VERSION', 'CLI_UNSUPPORTED'],
    ['UNSUPPORTED_CAPABILITY', 'POLICY_UNSUPPORTED'], ['REQUIRED_TRANSPORT_UNAVAILABLE', 'POLICY_UNSUPPORTED']]) {
    vi.spyOn(Agent.prototype, 'ready').mockRejectedValue(Object.assign(new Error('private diagnostics'), { code }));
    await expect(createAgent({ model: 'dummy/first' }, { runtime: runtime(), receipts })).rejects.toMatchObject({
      code: 'NO_ROUTE', receipt: { candidates: [{ code: expected }] },
    });
    vi.restoreAllMocks();
  }
});
