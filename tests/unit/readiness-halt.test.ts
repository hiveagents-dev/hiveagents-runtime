import { expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../src/public/execution-halt.js';
import { createAgent } from '../../src/routing/index.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import type { LearningStore } from '../../src/routing/learning/types.js';

const task = { id: 'task', version: '1', text: 'synthetic readiness', inputDigest: inputDigest('synthetic readiness') };
const domain = { id: 'real-readiness-halt', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
const definition = { transport: 'exec' as const, model: { mode: 'auto' as const,
  candidates: ['claude/sonnet', 'codex/gpt-5.4'], fallback: 'codex/gpt-5.4', allowUnverifiedModels: true } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

for (const entry of ['ready', 'selector', 'learning'] as const) {
  it.each(['direct', 'aggregate'] as const)(`real ${entry} retains a late %s probe halt after caller cancellation`, async shape => {
    const halt = new ExecutionHaltedError(), failure = shape === 'aggregate' ? new AggregateError([Error('primary'), halt]) : halt;
    const controller = new AbortController(), started = deferred(), settle = deferred();
    const probes: string[] = [], auth = vi.fn(async () => ({ authenticated: true, source: 'subscription' as const }));
    const execute = vi.fn(async () => { throw Error('must not generate'); });
    const adapters = ['claude', 'codex'].map(id => ({ id, async detect() {
      probes.push(id); started.resolve(); controller.abort(); await settle.promise; throw failure;
    }, auth, models: async () => [], execute } satisfies ExecAdapter));
    const runtime = new Runtime({ adapters }), puts = vi.fn();
    const evidence = { put: puts, pointer: async () => ({ generation: 0, active: null, previous: null }), get: async () => undefined,
      highWater: async () => 0, observations: async () => [], appendObservation: vi.fn(), commitGate: vi.fn(), pending: async () => [], close: vi.fn() } as unknown as LearningStore;
    const operation = entry === 'ready' ? new Agent({ model: 'claude/sonnet', transport: 'exec' }, runtime).ready({ signal: controller.signal, awaitSettlement: true })
      : entry === 'selector' ? createAgent(definition, { runtime, signal: controller.signal, receipts: { save: vi.fn(), load: async () => undefined } })
      : new LearningRouter({ domain, store: evidence }).preflight({ ...definition, model: { ...definition.model,
        candidates: [{ id: 'primary', model: 'claude/sonnet' }, { id: 'fallback', model: 'codex/gpt-5.4' }], fallback: 'fallback' } }, { runtime, task, signal: controller.signal });
    let done = false; const result = operation.then(value => { done = true; return value; }, error => { done = true; return error; });
    await Promise.race([started.promise, result.then(value => { throw value; })]); await Promise.resolve(); await Promise.resolve();
    expect(done).toBe(false); settle.resolve();
    const observed = await result;
    expect(observed).toBe(failure); expect(isExecutionHalted(observed)).toBe(true);
    expect(probes).toEqual(['claude']); expect(auth).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(puts).not.toHaveBeenCalled();
  });
}

it('ordinary late probe errors still preserve opted-in cancellation semantics', async () => {
  const controller = new AbortController();
  const runtime = new Runtime({ adapters: [{ id: 'claude', detect: async () => { controller.abort(); throw Error('ordinary failure'); },
    auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [], execute: async () => { throw Error('unused'); } }] });
  await expect(new Agent({ model: 'claude/sonnet', transport: 'exec' }, runtime).ready({ signal: controller.signal, awaitSettlement: true }))
    .rejects.toMatchObject({ code: 'ABORTED' });
});
