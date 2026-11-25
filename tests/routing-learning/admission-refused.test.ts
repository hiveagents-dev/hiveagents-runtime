import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { AgentReadiness } from '../../src/public/types.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import type { EvidenceMap, LearningObservation, LearningStore, PutKind } from '../../src/routing/learning/types.js';
// Policy-only learning fixture. No provider, process, admission or physical completion claim.
afterEach(() => vi.restoreAllMocks());
it('records an actual run-path admission refusal with unknown quality/latency and no trainable shadow', async () => {
    const rows = new Map<string, unknown>(), observations: LearningObservation[] = [];
    const store = { async put<K extends PutKind>(kind: K, id: string, value: EvidenceMap[K]) { rows.set(`${kind}:${id}`, value); }, async get(kind: string, id: string) { return rows.get(`${kind}:${id}`); }, async pointer() { return { generation: 0, active: null, previous: null }; }, async highWater() { return 0; }, async observations() { return []; }, async appendObservation(value: LearningObservation) { observations.push(value); return { sequence: observations.length, observation: value }; }, async commitGate() { throw Error('unused'); }, async pending() { return []; }, close() { } } as LearningStore;
    vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function (this: Agent) { return { ready: true, model: this.model, provider: this.model.provider, auth: { authenticated: true, source: 'subscription' }, installation: { installed: true }, capabilities: { unsupported: [], transport: 'exec' }, plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: '1', executableRealpath: '/owned/policy-fixture' }, capabilities: {}, envelope: {}, warnings: [] } } as unknown as AgentReadiness; });
    vi.spyOn(Agent.prototype, 'close').mockResolvedValue();
    const error = Object.assign(Error('static admission refusal'), { code: 'ADMISSION_REFUSED' });
    vi.spyOn(Agent.prototype, 'stream').mockImplementation(async function* () { throw error; });
    const verify = vi.fn(() => ({ value: 0, passed: false })), release = vi.fn(), router = new LearningRouter({ store, domain: { id: 'admission-test', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) } }), text = 'policy fixture';
    await expect(router.run({ model: 'codex/gpt-5.4' }, { runtime: new Runtime(), input: text, task: { id: 'task', version: '1', text, inputDigest: inputDigest(text) }, budget: { acquire: () => ({ release }) }, verify })).rejects.toBe(error);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.quality).toEqual({ state: 'unknown', reason: 'ADMISSION_REFUSED' });
    expect(observations[0]!.latency).toEqual({ state: 'unknown' });
    expect([...rows.keys()].some(k => k.startsWith('snapshot:'))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
});
