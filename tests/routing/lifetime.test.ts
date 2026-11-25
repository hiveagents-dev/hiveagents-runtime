import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { AgentReadiness } from '../../src/public/types.js';
import { createAgent, type RoutingReceipt, type RoutingReceiptStore } from '../../src/routing/index.js';
function gate<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const runtime = new Runtime();
function readiness(agent: Agent): AgentReadiness { return { ready: true, model: agent.model, provider: agent.model.provider,
  auth: { authenticated: true, source: 'subscription' }, installation: { installed: true }, capabilities: { unsupported: [] },
  plan: { transport: 'exec', fingerprint: {}, capabilities: {}, envelope: {}, warnings: [] } } as unknown as AgentReadiness; }
const model = { mode: 'auto' as const, candidates: ['codex/gpt-5.4', 'claude/sonnet'], fallback: 'claude/sonnet', allowUnverifiedModels: true };
afterEach(() => vi.restoreAllMocks());
it('drains an uncooperative readiness after parent abort and never probes fallback', async () => {
  const entered = gate<void>(); const finish = gate<void>(); const controller = new AbortController();
  const p = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { entered.resolve(); await finish.promise; return readiness(this); });
  const saved: RoutingReceipt[] = []; const receipts = { async save(r: RoutingReceipt) { saved.push(r); }, async load() { return undefined; } };
  let done = false; const pending = createAgent({ model }, { runtime, receipts, signal: controller.signal }).finally(() => { done = true; });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED', receipt: { decision: 'abstained', reason: 'ABORTED' } });
  await entered.promise; controller.abort(); await Promise.resolve(); expect(done).toBe(false); expect(saved).toHaveLength(0);
  finish.resolve(); await rejected; expect(p).toHaveBeenCalledOnce(); expect(saved).toHaveLength(1);
});
it('waits actual readiness settlement on deadline with no late fallback or returned agent', async () => {
  const entered = gate<void>(); const finish = gate<void>();
  const p = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { entered.resolve(); await finish.promise; return readiness(this); });
  const receipts = { async save() {}, async load() { return undefined; } }; let done = false;
  const pending = createAgent({ model }, { runtime, receipts, timeoutMs: 10 }).finally(() => { done = true; });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 25)); expect(done).toBe(false);
  finish.resolve(); await rejected; expect(p).toHaveBeenCalledOnce();
});
it('retains selected proposal when cancellation arrives during immutable save, returns no agent', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this); });
  const entered = gate<void>(); const finish = gate<void>(); const controller = new AbortController(); let saved: RoutingReceipt | undefined;
  const receipts = { async save(r: RoutingReceipt) { saved = r; entered.resolve(); await finish.promise; }, async load() { return saved; } };
  let done = false; const pending = createAgent({ model }, { runtime, receipts, signal: controller.signal }).finally(() => { done = true; });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED', receipt: { decision: 'selected', reason: 'PRIORITY' } });
  await entered.promise; controller.abort(); await Promise.resolve(); expect(done).toBe(false); expect(saved?.decision).toBe('selected');
  finish.resolve(); await rejected;
});
it('surfaces raw late save rejection after cancellation and never tries fallback', async () => {
  const p = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this); });
  const entered = gate<void>(); const finish = gate<void>(); const controller = new AbortController(); const failure = Error('raw-sink-failed');
  const receipts = { async save() { entered.resolve(); await finish.promise; }, async load() { return undefined; } };
  const pending = createAgent({ model }, { runtime, receipts, signal: controller.signal }); const rejected = expect(pending).rejects.toBe(failure);
  await entered.promise; controller.abort(); finish.reject(failure); await rejected; expect(p).toHaveBeenCalledOnce();
});
it('surfaces raw late save rejection after timeout and observes raw late load error', async () => {
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { return readiness(this); });
  const entered = gate<void>(); const finish = gate<void>(); const failure = Error('raw-load-error');
  const receipts = { async save() { entered.resolve(); await finish.promise; }, async load() { return undefined; } };
  const pending = createAgent({ model }, { runtime, receipts, timeoutMs: 10 }); const rejected = expect(pending).rejects.toBe(failure);
  await entered.promise; await new Promise(resolve => setTimeout(resolve, 25)); finish.reject(failure); await rejected;
});
it('snapshots definition, tools metadata, task and store methods before await', async () => {
  const entered = gate<void>(); const finish = gate<void>();
  const p = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) { entered.resolve(); await finish.promise; return readiness(this); });
  const saved: RoutingReceipt[] = []; const receipts: RoutingReceiptStore = { async save(r) { saved.push(r); }, async load() { return undefined; } };
  const definition = { model: { ...model, candidates: [...model.candidates] }, instructions: 'secret-before' };
  const task = { id: 'task', version: '1', inputDigest: 'a'.repeat(64), tags: ['before'] };
  const pending = createAgent(definition, { runtime, receipts, task }); await entered.promise;
  definition.model.candidates.reverse(); definition.instructions = 'secret-after'; task.tags.push('after'); receipts.save = async () => { throw Error('mutated callback'); };
  finish.resolve(); const { receipt } = await pending; expect(receipt.selected?.provider).toBe('codex'); expect(saved).toHaveLength(1); expect(p).toHaveBeenCalledOnce();
  expect(JSON.stringify(receipt)).not.toMatch(/secret-before|secret-after|before|after/);
});
it('persists pre-aborted validated requests with zero probes', async () => {
  const p = vi.spyOn(Agent.prototype, 'ready'); const controller = new AbortController(); controller.abort(); const saved: RoutingReceipt[] = [];
  await expect(createAgent({ model }, { runtime, receipts: { async save(r) { saved.push(r); }, async load() { return undefined; } }, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  expect(saved).toHaveLength(1); expect(p).not.toHaveBeenCalled();
});
