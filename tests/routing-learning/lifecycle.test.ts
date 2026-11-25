import { afterEach, expect, it, vi } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import type { AgentReadiness, Turn } from '../../src/public/types.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import type { EvidenceMap, LearningObservation, LearningStore, PutKind, SequencedObservation } from '../../src/routing/learning/types.js';
const runtime = new Runtime();
const domain = { id: 'lifecycle', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
const text = 'private test input';
function harness() {
  const records = new Map<string, unknown>(), observations: SequencedObservation[] = [];
  const store = {
    async put<K extends PutKind>(kind: K, id: string, value: EvidenceMap[K]) { if (records.has(`${kind}:${id}`)) throw new Error('duplicate id'); records.set(`${kind}:${id}`, value); },
    async get(kind: string, id: string) { return records.get(`${kind}:${id}`); }, async pointer() { return { generation: 0, active: null, previous: null }; },
    async highWater() { return observations.length; }, async observations() { return observations; },
    async appendObservation(observation: LearningObservation) { const row = { sequence: observations.length + 1, observation }; observations.push(row); return row; },
    async commitGate() { throw new Error('unused'); }, async pending() { return []; }, close() {},
  } as LearningStore;
  let held = false;
  const release = vi.fn(() => { held = false; });
  const budget = { acquire: vi.fn(() => { if (held) throw new Error('nested reservation'); held = true; return { release }; }) };
  const context = { runtime, input: text, task: { id: 'task', version: '1', text, inputDigest: inputDigest(text) }, budget, verify: vi.fn(() => ({ value: 1, passed: true })) };
  const router = new LearningRouter({ store, domain });
  return { records, observations, store, context, router, release, held: () => held };
}
function ready(agent: Agent, version = '1', transport = 'exec'): AgentReadiness {
  return { ready: true, model: agent.model, provider: agent.model.provider, auth: { authenticated: true, source: 'subscription' }, installation: { installed: true },
    capabilities: { unsupported: [], transport }, plan: { transport, fingerprint: { adapterVersion: '1', cliVersion: version, executableRealpath: '/private/canary' }, capabilities: {}, envelope: { authorityEpoch: crypto.randomUUID() }, warnings: [] },
  } as unknown as AgentReadiness;
}
function turn(): Turn { return { status: 'completed', session: { provider: 'codex', model: 'gpt-5.4' } as Turn['session'], text: 'private result', events: [], warnings: [], providerMetadata: {} }; }
function standard() {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return ready(this); });
  vi.spyOn(Agent.prototype, 'close').mockResolvedValue();
  return vi.spyOn(Agent.prototype, 'stream').mockImplementation(async function* (_input, options) { expect(options?.awaitSettlement).toBe(true); yield { type: 'turn.completed' as const, turn: turn() }; });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('reserves once through durable outcome/shadow, releases before maintenance and keeps actual result on hook failure', async () => {
  const stream = standard(); const h = harness();
  const maintenance = vi.fn(async () => { expect(h.held()).toBe(false); throw new Error('maintenance failed'); });
  const result = await h.router.run({ model: 'codex/gpt-5.4' }, { ...h.context, maintenance, id: 'decision', attemptId: 'attempt', observationId: 'observation' });
  expect(stream).toHaveBeenCalledOnce(); expect(h.context.budget.acquire).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  expect(result.observation.quality).toEqual({ state: 'verified', value: 1, passed: true });
  expect(h.records.has('attempt:attempt')).toBe(true); expect(result.shadow.rows).toHaveLength(1);
  expect(result.maintenance).toEqual({ status: 'failed', code: 'MAINTENANCE_FAILED' }); expect(result.turn.text).toBe('private result');
  expect(JSON.stringify([...h.records.values(), ...h.observations])).not.toContain(text);
  expect(JSON.stringify([...h.records.values(), ...h.observations])).not.toContain('private result');
});
it('records unknown on verifier failure, settles cleanup, and never retries another arm', async () => {
  const stream = standard(); const h = harness(); const error = new Error('oracle failed');
  await expect(h.router.run({ model: { mode: 'auto', candidates: [{ id: 'a', model: 'codex/gpt-5.4' }, { id: 'b', model: 'claude/sonnet' }], allowUnverifiedModels: true } }, { ...h.context, verify() { throw error; } })).rejects.toBe(error);
  expect(stream).toHaveBeenCalledOnce(); expect(h.observations[0]!.observation.outcome).toBe('verifier-error');
  expect(h.observations[0]!.observation.quality.state).toBe('unknown'); expect(h.release).toHaveBeenCalledOnce();
});
it('records post-run execution drift as unknown and does not call the verifier', async () => {
  standard(); const h = harness(); let calls = 0;
  vi.mocked(Agent.prototype.ready).mockImplementation(async function(this: Agent) { return ready(this, ++calls >= 3 ? 'changed' : '1'); });
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, h.context)).rejects.toThrow(/identity/i);
  expect(h.observations[0]!.observation.outcome).toBe('identity-drift'); expect(h.context.verify).not.toHaveBeenCalled();
});
it('rejects negotiated control before opening a session, but records the durable unknown attempt', async () => {
  const stream = standard(); const h = harness();
  vi.mocked(Agent.prototype.ready).mockImplementation(async function(this: Agent) { return ready(this, '1', 'control'); });
  await expect(h.router.run({ model: 'codex/gpt-5.4', transport: 'control' }, h.context)).rejects.toThrow(/exec/i);
  expect(stream).not.toHaveBeenCalled(); expect(h.observations).toHaveLength(1); expect(h.observations[0]!.observation.latency.state).toBe('unknown');
});
it('captures verifier/input/budget before the first await and suppresses matrix maintenance', async () => {
  standard(); const h = harness(); const maintenance = vi.fn(async () => {});
  const definition = { model: { mode: 'auto' as const, allowUnverifiedModels: true, candidates: [{ id: 'a', model: 'codex/gpt-5.4' }] } };
  const context = { ...h.context, evaluationArmId: 'a', maintenance };
  const originalVerify = context.verify;
  h.context.budget.acquire.mockImplementation(() => {
    context.verify = vi.fn(() => { throw new Error('mutated'); }); context.input = 'mutated'; context.task.text = 'mutated';
    context.budget = { acquire: vi.fn(() => { throw new Error('mutated budget'); }) } as typeof context.budget;
    definition.model.candidates[0]!.model = 'claude/sonnet';
    return { release: h.release };
  });
  const result = await h.router.run(definition, context);
  expect(result.observation.quality.state).toBe('verified'); expect(result.receipt.selected?.provider).toBe('codex');
  expect(originalVerify).toHaveBeenCalledOnce(); expect(context.verify).not.toHaveBeenCalled();
  expect(vi.mocked(Agent.prototype.stream).mock.calls[0]![0]).toBe(text);
  expect(maintenance).not.toHaveBeenCalled(); expect(result.maintenance.status).toBe('not-requested');
});
it('does not dispatch when durable attempt start collides', async () => {
  const stream = standard(); const h = harness();
  h.records.set('attempt:collision', {});
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, { ...h.context, attemptId: 'collision' })).rejects.toThrow(/duplicate/i);
  expect(stream).not.toHaveBeenCalled(); expect(h.observations).toHaveLength(0); expect(h.context.budget.acquire).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
});
it('retains provider failure and raw observation IO failure in an aggregate', async () => {
  standard(); const h = harness(); const provider = new Error('provider'), io = new Error('storage');
  vi.mocked(Agent.prototype.stream).mockImplementation(async function* () { throw provider; });
  h.store.appendObservation = async () => { throw io; };
  const router = new LearningRouter({ store: h.store, domain });
  await expect(router.run({ model: 'codex/gpt-5.4' }, h.context)).rejects.toMatchObject({ errors: [provider, io] });
});
it('holds the reservation until a cancelled stream actually settles and records censored latency', async () => {
  standard(); const h = harness(); const controller = new AbortController();
  let unblock!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const pending = new Promise<void>(resolve => { unblock = resolve; });
  vi.mocked(Agent.prototype.stream).mockImplementation(async function* (_input, options) {
    entered(); await pending; expect(options?.signal?.aborted).toBe(true); yield { type: 'turn.completed' as const, turn: turn() };
  });
  const run = h.router.run({ model: 'codex/gpt-5.4' }, { ...h.context, signal: controller.signal });
  const rejected = expect(run).rejects.toThrow(); await started; controller.abort();
  await Promise.resolve(); expect(h.held()).toBe(true); expect(h.release).not.toHaveBeenCalled();
  unblock(); await rejected;
  expect(h.observations[0]!.observation.outcome).toBe('aborted'); expect(h.observations[0]!.observation.latency.state).toBe('right-censored');
  expect(h.observations[0]!.observation.quality.state).toBe('unknown'); expect(h.release).toHaveBeenCalledOnce();
});
it('never reads a provider exception getter and still records an unknown observation', async () => {
  standard(); const h = harness(); const getter = vi.fn(() => 'SECRET');
  const error = Object.defineProperty({}, 'code', { get: getter });
  vi.mocked(Agent.prototype.stream).mockImplementation(async function* () { throw error; });
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, h.context)).rejects.toBe(error);
  expect(getter).not.toHaveBeenCalled(); expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('treats established reported backend fallback as unknown rather than copying its quality', async () => {
  standard(); const h = harness();
  vi.mocked(Agent.prototype.stream).mockImplementation(async function* () { yield { type: 'turn.completed', turn: { ...turn(), usage: { costMeaning: 'provider-reported', perModel: { 'other-backend': { inputTokens: 1 } } } } }; });
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, h.context)).rejects.toThrow(/identity/i);
  expect(h.observations[0]!.observation.observedModels).toEqual(['other-backend']); expect(h.context.verify).not.toHaveBeenCalled();
});
it('retains a raw late decision IO failure even if cancellation has already won', async () => {
  standard(); const h = harness(); const controller = new AbortController(), io = new Error('late IO failure');
  const original = h.store.put.bind(h.store); let unblock!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { unblock = resolve; });
  h.store.put = async (kind, id, row) => { if (kind === 'decision') { entered(); await pending; throw io; } return original(kind, id, row); };
  const router = new LearningRouter({ store: h.store, domain });
  const run = router.run({ model: 'codex/gpt-5.4' }, { ...h.context, signal: controller.signal });
  const rejected = expect(run).rejects.toBe(io); await started; controller.abort(); expect(h.held()).toBe(true); unblock(); await rejected;
  expect(h.observations).toHaveLength(0); expect(h.release).toHaveBeenCalledOnce();
});
it('does not mistake a thrown undefined value for a successful run', async () => {
  standard(); const h = harness();
  vi.mocked(Agent.prototype.stream).mockImplementation(async function* () { throw undefined; });
  let resolved = false, rejected = false;
  await h.router.run({ model: 'codex/gpt-5.4' }, h.context).then(() => { resolved = true; }, error => { rejected = true; expect(error).toBeUndefined(); });
  expect(resolved).toBe(false); expect(rejected).toBe(true); expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('does not read a late status getter installed while post-run readiness settles', async () => {
  standard(); const h = harness(); const completed = turn(); let readyCalls = 0;
  const getter = vi.fn(() => 'SECRET');
  vi.mocked(Agent.prototype.stream).mockImplementation(async function* () { yield { type: 'turn.completed', turn: completed }; });
  vi.mocked(Agent.prototype.ready).mockImplementation(async function(this: Agent) {
    if (++readyCalls === 3) Object.defineProperty(completed, 'status', { configurable: true, enumerable: true, get: getter });
    return ready(this);
  });
  const result = await h.router.run({ model: 'codex/gpt-5.4' }, h.context);
  expect(result.observation.quality.state).toBe('verified'); expect(getter).not.toHaveBeenCalled();
});
it('reapplies readiness hard filters immediately before dispatch', async () => {
  const stream = standard(); const h = harness(); let calls = 0;
  vi.mocked(Agent.prototype.ready).mockImplementation(async function(this: Agent) {
    const value = ready(this); if (++calls === 2) value.capabilities.unsupported.push('newly-unsupported-permission'); return value;
  });
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, h.context)).rejects.toThrow(/identity/i);
  expect(stream).not.toHaveBeenCalled(); expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('validates train and heldout repetition metadata before acquiring a reservation', async () => {
  standard(); const h = harness();
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, { ...h.context, repetition: 0 })).rejects.toThrow();
  await expect(h.router.run({ model: 'codex/gpt-5.4' }, { ...h.context, split: 'fresh', episodeId: 'prospective' })).rejects.toThrow();
  expect(h.context.budget.acquire).not.toHaveBeenCalled(); expect(Agent.prototype.ready).not.toHaveBeenCalled();
});
it('starts the overall deadline before budget admission and releases late admission without probing', async () => {
  standard(); const h = harness();
  // Fake time (timers and performance.now): setup before admission costs no deadline however loaded the runner is,
  // so admission is always reached, and the 5 ms deadline can only expire during the 25 ms admission.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let admittedAt: number | undefined;
  h.context.budget.acquire.mockImplementation((async () => { await new Promise(resolve => setTimeout(resolve, 25)); admittedAt = performance.now(); return { release: h.release }; }) as never);
  const run = h.router.run({ model: 'codex/gpt-5.4' }, { ...h.context, timeoutMs: 5 });
  const refused = expect(run).rejects.toThrow(/deadline/i);
  await vi.advanceTimersByTimeAsync(25);
  await refused;
  expect(h.context.budget.acquire).toHaveBeenCalledOnce(); expect(admittedAt).toBe(25);
  expect(h.release).toHaveBeenCalledOnce(); expect(Agent.prototype.ready).not.toHaveBeenCalled(); expect(h.observations).toHaveLength(0);
});
