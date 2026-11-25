import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import type { AgentReadiness, Turn } from '../../src/public/types.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
import { hashTaskFeatures, inputDigest } from '../../src/routing/learning/features.js';
import type { LearningDefinition, LearningPolicyBinding, LearningRunContext } from '../../src/routing/learning/types.js';

const domain = { id: 'expected-binding', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
const definition: LearningDefinition = { model: { mode: 'auto', allowUnverifiedModels: true,
  candidates: [{ id: 'sol', model: 'codex/gpt-5.4' }, { id: 'sonnet', model: 'claude/sonnet' }] }, transport: 'exec' };
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-expected-binding-')); directories.push(directory);
  const store = new SqliteLearningStore(join(directory, 'evidence.sqlite'));
  let version = '1', claudeReady = true;
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) {
    if (this.model.provider === 'claude' && !claudeReady) throw new Error('CLI temporarily unavailable');
    return { ready: true, model: this.model, provider: this.model.provider, auth: { authenticated: true, source: 'subscription' },
      installation: { installed: true }, capabilities: { unsupported: [], transport: 'exec' },
      plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: version, executableRealpath: '/private/test-cli' },
        capabilities: {}, envelope: { authorityEpoch: crypto.randomUUID() }, warnings: [] } } as unknown as AgentReadiness;
  });
  vi.spyOn(Agent.prototype, 'close').mockResolvedValue();
  const stream = vi.spyOn(Agent.prototype, 'stream').mockImplementation(async function*(this: Agent) {
    yield { type: 'turn.completed' as const, turn: { status: 'completed', text: '{"answer":1}',
      session: { provider: this.model.provider, model: this.model.id }, events: [], warnings: [], providerMetadata: {} } as unknown as Turn };
  });
  const router = new LearningRouter({ store, domain }), runtime = new Runtime();
  const text = 'Return a JSON answer for this binding test', task = { id: 'task', version: '1', text, inputDigest: inputDigest(text) };
  const preflight = await router.preflight(definition, { runtime, task });
  const features = hashTaskFeatures(text);
  const expectedBinding: LearningPolicyBinding = { definitionDigest: preflight.definitionDigest, actions: structuredClone(preflight.actions),
    features: { schema: features.schema, dimensions: features.values.length } };
  const release = vi.fn(), acquire = vi.fn(() => ({ release }));
  const context: LearningRunContext & { expectedBinding: LearningPolicyBinding } = { runtime, task, input: text,
    budget: { acquire }, verify: () => ({ value: 1, passed: true }), expectedBinding };
  return { router, store, stream, context, acquire, release, preflight,
    changeVersion: () => { version = '2'; }, removeClaude: () => { claudeReady = false; } };
}

it('refuses an executable identity changed during admission before durable start or dispatch', async () => {
  const h = await setup();
  h.acquire.mockImplementation(() => { h.changeVersion(); return { release: h.release }; });
  try {
    await expect(h.router.run(definition, h.context)).rejects.toThrow(/binding|universe/i);
    expect(h.stream).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledOnce();
    expect(await h.store.pending(h.preflight.domain)).toEqual([]); expect(await h.store.highWater(h.preflight.domain)).toBe(0);
  } finally { h.store.close(); }
});

it('refuses a narrowed ready universe even when the original primary remains eligible', async () => {
  const h = await setup();
  h.acquire.mockImplementation(() => { h.removeClaude(); return { release: h.release }; });
  try {
    await expect(h.router.run(definition, h.context)).rejects.toThrow(/binding|universe/i);
    expect(h.stream).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledOnce();
  } finally { h.store.close(); }
});

it('captures a matching binding before caller mutation and keeps the successful verified turn', async () => {
  const h = await setup();
  h.acquire.mockImplementation(() => { h.context.expectedBinding.definitionDigest = 'f'.repeat(64); return { release: h.release }; });
  try {
    const result = await h.router.run(definition, h.context);
    expect(result.observation.quality).toEqual({ state: 'verified', value: 1, passed: true });
    expect(h.stream).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  } finally { h.store.close(); }
});

it('rejects malformed or request-incompatible binding without admission or getter execution', async () => {
  const h = await setup(), getter = vi.fn(() => h.context.expectedBinding);
  try {
    const bad = Object.defineProperty({}, 'actions', { get: getter, enumerable: true });
    await expect(h.router.run(definition, { ...h.context, expectedBinding: bad as LearningPolicyBinding })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(h.acquire).not.toHaveBeenCalled();
    h.context.expectedBinding.features.schema = 'other-schema';
    await expect(h.router.run(definition, h.context)).rejects.toThrow(/binding|feature/i);
    expect(h.acquire).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});

it.each([null, false, 0, ''])('rejects an explicit invalid falsy binding %s instead of silently omitting the guard', async value => {
  const h = await setup();
  try {
    await expect(h.router.run(definition, { ...h.context, expectedBinding: value as unknown as LearningPolicyBinding })).rejects.toThrow();
    expect(h.acquire).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});
