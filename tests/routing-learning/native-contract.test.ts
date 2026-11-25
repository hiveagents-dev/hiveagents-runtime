import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { RecordingExec, success } from '../unit/memory.fixture.js';
import type { AgentReadiness, Turn } from '../../src/public/types.js';
import * as learning from '../../src/routing/learning/index.js';
import { captureSelection } from '../../src/routing/learning/factory-context.js';
import type { LearningDefinition, LearningEpisode, LearningPolicyBinding, LearningRunContext } from '../../src/routing/learning/types.js';

const runtime = new Runtime();
const domain = { id: 'native-contract', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
const text = 'Return the verified result';
const task = { id: 'task', version: '1', text, inputDigest: learning.inputDigest(text) };
const context = { runtime, task };
const directories: string[] = [];
const schema = () => ({
  type: 'object', properties: { result: { type: 'number' } }, required: ['result'], additionalProperties: false,
});
const definition = (): LearningDefinition => ({
  model: { mode: 'auto', allowUnverifiedModels: true,
    candidates: [{ id: 'claude', model: 'claude/sonnet', profile: 'writer' }, { id: 'codex', model: 'codex/gpt-5.4', profile: 'reviewer' }] },
  transport: 'exec', cwd: '/private/kanban', requireAuth: 'subscription', environment: { mode: 'minimal' },
  instructions: 'Return the verified result.',
  profiles: {
    writer: { provider: 'claude', context: { profile: 'clean', memory: 'off' }, permissions: { mode: 'respond' },
      providerOptions: { claude: { systemPromptMode: 'replace', tools: [] } } },
    reviewer: { provider: 'codex', context: { profile: 'native', memory: 'off' },
      permissions: { mode: 'analyze', minimumEnforcement: 'sandbox' }, providerOptions: { codex: { ephemeral: true } } },
  },
  outputSchema: schema(),
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'learning-native-contract-')); directories.push(directory);
  const store = new learning.SqliteLearningStore(join(directory, 'evidence.sqlite'));
  const router = new learning.LearningRouter({ store, domain });
  const unsupported = new Set<string>();
  const ready = vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) {
    return { ready: true, model: this.model, provider: this.model.provider, auth: { authenticated: true, source: 'subscription' },
      installation: { installed: true }, capabilities: { unsupported: [], transport: 'exec',
        features: { structuredOutput: unsupported.has(this.model.provider) ? 'unsupported' : 'supported' } },
      plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: '1', executableRealpath: '/private/test-cli' },
        capabilities: {}, envelope: { authorityEpoch: crypto.randomUUID() }, warnings: [] } } as unknown as AgentReadiness;
  });
  vi.spyOn(Agent.prototype, 'close').mockResolvedValue();
  const stream = vi.spyOn(Agent.prototype, 'stream').mockImplementation(async function*(this: Agent) {
    yield { type: 'turn.completed', turn: { status: 'completed', text: '{"result":7}', output: { result: 7 },
      session: { provider: this.model.provider, model: this.model.id }, events: [], warnings: [], providerMetadata: {} } as unknown as Turn };
  });
  const release = vi.fn();
  const acquire = vi.fn(() => ({ release }));
  const verify = vi.fn((turn: Turn) => ({ value: Number((turn.output as { result: number })?.result === 7), passed: true }));
  const run: LearningRunContext = { ...context, input: text, budget: { acquire }, verify };
  return { store, router, ready, unsupported, stream, release, acquire, verify, run };
}

it('resolves two explicit provider profiles without altering shared execution authority', () => {
  const captured = captureSelection(definition(), context);
  const [writer, reviewer] = captured.arms.map(arm => arm.options);
  expect(writer).toMatchObject({ cwd: '/private/kanban', transport: 'exec', requireAuth: 'subscription', permissions: { mode: 'respond' },
    context: { profile: 'clean' }, providerOptions: { claude: { tools: [] } } });
  expect(reviewer).toMatchObject({ cwd: '/private/kanban', transport: 'exec', requireAuth: 'subscription', permissions: { mode: 'analyze', minimumEnforcement: 'sandbox' },
    context: { profile: 'native' }, providerOptions: { codex: { ephemeral: true } } });
});

it.each([
  () => ({ ...definition(), permissions: { mode: 'analyze' } }),
  () => ({ ...definition(), profiles: { ...definition().profiles, writer: { provider: 'codex' } } }),
  () => ({ ...definition(), profiles: { ...definition().profiles, writer: { provider: 'claude', cwd: '/other' } } }),
  () => ({ ...definition(), profiles: { ...definition().profiles, writer: { provider: 'claude', providerOptions: { codex: { ephemeral: false } } } } }),
  () => ({ ...definition(), profiles: {} }),
])('fails closed on malformed, mismatched or authority-overriding profile configuration', async makeDefinition => {
  const h = await setup();
  try {
    await expect(h.router.run(makeDefinition() as LearningDefinition, h.run)).rejects.toThrow();
    expect(h.ready).not.toHaveBeenCalled(); expect(h.acquire).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});

it('excludes an unsupported native output channel before dispatch and exposes a durable typed abstention', async () => {
  const h = await setup();
  h.unsupported.add('claude'); h.unsupported.add('codex');
  try {
    const preflight = await h.router.preflight(definition(), context);
    expect(preflight.actions).toEqual([]);
    expect(preflight.candidates.map(candidate => candidate.code)).toEqual(['POLICY_UNSUPPORTED', 'POLICY_UNSUPPORTED']);
    const error = await h.router.run(definition(), { ...h.run, id: 'no-native-route' }).catch(value => value);
    expect(error).toBeInstanceOf(learning.LearningSelectionError);
    expect(error).toMatchObject({ code: 'NO_ROUTE', receipt: { reason: 'NO_ROUTE', nativeDispatches: 0 } });
    expect(error.receipt).not.toHaveProperty('selected');
    expect(await h.store.get('decision', 'no-native-route')).toEqual(error.receipt);
    expect(await h.store.pending(preflight.domain)).toEqual([]);
    expect(h.release).toHaveBeenCalledOnce(); expect(h.stream).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});

it('uses the captured native schema with a compatible arm and separates actions from unschematized runs', async () => {
  const h = await setup();
  h.unsupported.add('claude');
  try {
    const current = definition();
    const full = await h.router.preflight(current, context);
    const { outputSchema: _, ...textOnly } = current;
    const plain = await h.router.preflight(textOnly, context);
    expect(full.definitionDigest).not.toBe(plain.definitionDigest);
    expect(full.actions[0]?.key).not.toBe(plain.actions.find(action => action.id === 'codex')?.key);
    h.acquire.mockImplementation(() => {
      current.outputSchema!.required = ['mutated'];
      return { release: h.release };
    });
    const result = await h.router.run(current, h.run);
    expect(result.receipt.selected?.id).toBe('codex');
    expect(result.receipt.definitionDigest).toBe(full.definitionDigest);
    expect(h.stream.mock.calls[0]?.[1]?.outputSchema).toEqual(schema());
    expect(result.observation.quality).toEqual({ state: 'verified', value: 1, passed: true });
    expect((await h.router.shadow(textOnly, context)).rows).toEqual([]);
  } finally { h.store.close(); }
});

it('rejects a malformed native schema or a held-out schema drift before launching work', async () => {
  const h = await setup();
  const current = definition();
  try {
    await expect(h.router.run({ ...current, outputSchema: { type: 'impossible' } }, h.run)).rejects.toThrow(/schema/i);
    expect(h.ready).not.toHaveBeenCalled(); expect(h.acquire).not.toHaveBeenCalled();
    const preflight = await h.router.preflight(current, context);
    const features = learning.hashTaskFeatures(text);
    const expectedBinding: LearningPolicyBinding = { definitionDigest: preflight.definitionDigest, actions: preflight.actions,
      features: { schema: features.schema, dimensions: features.values.length } };
    const cells = preflight.actions.map(action => ({ actionKey: action.key, taskDigest: task.inputDigest, repetition: 0,
      attemptId: 'attempt-' + action.id, observationId: 'obs-' + action.id }));
    const episode: LearningEpisode = learning.sealLearningRecord('episode', { format: 1, id: 'fixed-matrix', kind: 'fixed', domain: preflight.domain,
      createdAt: Date.now(), definitionDigest: preflight.definitionDigest, protocolDigest: domain.protocolDigest, afterSequence: 0,
      arms: preflight.actions, tasks: [{ taskDigest: task.inputDigest, features }], repetitions: 1, cells });
    await h.store.put('episode', episode.id, episode);
    const incompatible = { ...current, outputSchema: { ...schema(), additionalProperties: true } };
    await expect(h.router.run(incompatible, { ...h.run, expectedBinding })).rejects.toThrow(/binding/i);
    await expect(h.router.run(incompatible, { ...h.run, evaluationArmId: 'codex', split: 'fixed', episodeId: episode.id, repetition: 0 })).rejects.toThrow(/episode scope/i);
    expect(h.acquire).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});

it('never surfaces a no-route abstention from a verifier after a native dispatch', async () => {
  const h = await setup();
  h.unsupported.add('claude'); h.unsupported.add('codex');
  try {
    const abstention = await h.router.run(definition(), h.run).catch(value => value);
    expect(abstention).toBeInstanceOf(learning.LearningSelectionError);
    h.unsupported.clear();
    const late = await h.router.run(definition(), { ...h.run, verify() { throw abstention; } }).catch(value => value);
    expect(late).not.toBeInstanceOf(learning.LearningSelectionError);
    expect(h.stream).toHaveBeenCalledOnce();
  } finally { h.store.close(); }
});

it('validates native adapter output before the verifier and never replays a failed structured turn', async () => {
  const h = await setup();
  vi.restoreAllMocks();
  const cli = new RecordingExec();
  const nativeRuntime = new Runtime({ adapters: [cli] });
  try {
    cli.executeImpl = async request => success(request.sessionId ?? 'native-session', {
      text: '{"result":"invalid"}', output: { result: 'invalid' },
    });
    const request = { ...h.run, runtime: nativeRuntime, attemptId: 'structured-attempt' };
    const fixed: LearningDefinition = { model: 'claude/sonnet', transport: 'exec', outputSchema: schema() };
    await expect(h.router.run(fixed, request)).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_ERROR' });
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0]?.outputSchema).toEqual(schema());
    expect(h.verify).not.toHaveBeenCalled();
    const preflight = await h.router.preflight(fixed, { ...context, runtime: nativeRuntime });
    const rows = await h.store.observations(preflight.domain);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observation.quality.state).toBe('unknown');
    await expect(h.router.run(fixed, request)).rejects.toThrow(/duplicate/i);
    expect(cli.requests).toHaveLength(1);
  } finally { h.store.close(); }
});
