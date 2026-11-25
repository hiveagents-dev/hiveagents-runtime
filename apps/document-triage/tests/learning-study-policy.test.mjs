import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Runtime } from 'hiveagents-runtime';
import { LearningRouter, learningDomainDigest, learningDigest, sealLearningRecord, assessGateEvidence, validateLearningRecord } from 'hiveagents-runtime/routing/learning';
import { LearningStudyRunner } from '../dist/learning-study.js';

function memoryEvidence() {
  const records = new Map(), rows = []; let pointer = { generation: 0, active: null, previous: null };
  const get = (kind, id) => records.get(`${kind}:${id}`);
  const store = {
    async put(kind, id, value) { validateLearningRecord(kind, value); const old = get(kind, id); if (old && old.digest !== value.digest) throw new Error('Immutable record collision'); records.set(`${kind}:${id}`, value); },
    async get(kind, id) { return get(kind, id); }, async pointer() { return pointer; }, async highWater() { return rows.length; },
    async observations(domain, options = {}) { return rows.filter(row => row.observation.domain === domain && (!options.split || row.observation.split === options.split)
      && (!options.through || row.sequence <= options.through) && (!options.verifiedOnly || row.observation.quality.state === 'verified')
      && (!options.observationIds || options.observationIds.includes(row.observation.id))
      && (!options.actionKeys || options.actionKeys.includes(row.observation.action.key))).slice(-(options.limit ?? rows.length)); },
    async appendObservation(value) { validateLearningRecord('observation', value); const old = get('observation', value.id); if (old) return rows.find(row => row.observation.id === old.id);
      records.set(`observation:${value.id}`, value); const row = { sequence: rows.length + 1, observation: value }; rows.push(row); return row; },
    async pending(domain) { return [...records.entries()].filter(([key, value]) => key.startsWith('attempt:') && value.domain === domain && !get('observation', value.observationId)).map(([, value]) => value); },
    async commitGate(gate) {
      if (get('gate-commit', gate.id)) return get('gate-commit', gate.id);
      const fresh = get('episode', gate.fresh.episodeId), fixed = get('episode', gate.fixed.episodeId);
      const recomputed = assessGateEvidence({ id: gate.id, createdAt: gate.createdAt, domain: gate.domain, fresh, fixed, observations: rows,
        ...(gate.from === null ? {} : { fromSnapshot: get('snapshot', gate.from) }), ...(gate.to === null ? {} : { toSnapshot: get('snapshot', gate.to) }) });
      assert.equal(recomputed.digest, gate.digest);
      const before = pointer;
      const matches = pointer.generation === gate.expectedGeneration && pointer.active === gate.from && (gate.mode !== 'rollback' || pointer.previous === gate.to);
      let status = matches ? 'kept' : 'stale';
      if (matches && gate.outcome !== 'keep') { pointer = { generation: pointer.generation + 1, active: gate.to, previous: pointer.active }; status = gate.mode === 'rollback' ? 'rolled-back' : 'promoted'; }
      const commit = sealLearningRecord('gate-commit', { format: 1, id: gate.id, domain: gate.domain, gateDigest: gate.digest, status, before, after: pointer, createdAt: Date.now() });
      records.set(`gate:${gate.id}`, gate); records.set(`gate-commit:${gate.id}`, commit); return commit;
    }, close() {},
  };
  return { store, records, rows };
}
function policyCorpus(batches = 1) {
  const item = (id, family) => ({ id, text: `${family === 'arithmetic' ? 'Calculate arithmetic integer addition exact sum' : 'Classify document message network support category'} request unique ${id}. Return JSON.`, expected: family === 'arithmetic' ? 1 : 'network' });
  const tasks = (prefix, count) => ['arithmetic','classification'].flatMap(family => Array.from({ length: count }, (_, i) => item(`${prefix}-${family}-${i}`, family)));
  return { format: 1, id: 'arbitrary-families', oracle: 'json-exact-v1', study: { maxCycles: 2, maxLaunches: 200, minNewTasks: 2 }, evaluation: { repetitions: 2 },
    train: tasks('train', 12), fixed: tasks('fixed', 1), freshBatches: Array.from({ length: batches }, (_, i) => ({ id: `batch-${i}`, tasks: tasks(`fresh-${i}`, 6) })) };
}

test('arbitrary task families promote, freeze a learned policy and roll back to the null incumbent using distinct votes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-memory-policy-')), { store, rows } = memoryEvidence();
  const domainObject = { id: 'arbitrary-families', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
  const router = new LearningRouter({ store, domain: domainObject, policy: { minSimilarity: .5, alpha: .025 } });
  let calls = 0, drift = false;
  const ready = mock.method(Agent.prototype, 'ready', async function () { return { ready: true, model: this.model, provider: this.model.provider,
    auth: { authenticated: true, source: 'subscription' }, installation: { installed: true }, capabilities: { unsupported: [], transport: 'exec' },
    plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: '1', executableRealpath: '/fixture' }, capabilities: {}, envelope: {}, warnings: [] } }; });
  const stream = mock.method(Agent.prototype, 'stream', async function* (input) {
    calls++; const classification = input.includes('Classify'), specialized = this.model.provider === 'claude';
    const passed = drift ? !specialized : specialized === classification;
    yield { type: 'turn.completed', turn: { status: 'completed', session: { provider: this.model.provider, model: this.model.id }, text: JSON.stringify(passed ? classification ? 'network' : 1 : null), events: [], warnings: [], providerMetadata: {} } };
  });
  const close = mock.method(Agent.prototype, 'close', async () => {});
  const environment = { directory, domain: learningDomainDigest(domainObject), protocolDigest: domainObject.protocolDigest, definition: { model: { mode: 'auto', allowUnverifiedModels: true,
    candidates: [{ id: 'arithmetic', model: 'codex/gpt-5.4' }, { id: 'classification', model: 'claude/sonnet' }] }, transport: 'exec' }, timeoutMs: 60000,
    runtime: new Runtime(), router, evidence: store, corpus: policyCorpus(), budget: { acquire() { return { release() {} }; } } };
  try {
    const first = await new LearningStudyRunner(environment).run({ maxLaunches: 200 });
    assert.equal(first.status, 'completed'); const report = first.cycles[0];
    assert.equal(report.commit.status, 'promoted'); assert.equal(first.pointer.generation, 1); assert.equal(report.gate.fresh.wins, 6);
    assert.ok(Math.abs(report.gate.fresh.pValue - .015625) < 1e-12); assert.equal(report.gate.fresh.tasks.length, 12);
    assert.equal(report.comparison.learnedPassRate, 1); assert.equal(report.comparison.incumbentPassRate, .5); assert.equal(report.comparison.bestFixedPassRate, .5);
    assert.equal(rows.filter(row => row.observation.split === 'train').length, 48);
    assert.equal(calls, 104); drift = true;
    const second = await new LearningStudyRunner({ ...environment, corpus: policyCorpus(2) }).run({ maxLaunches: 100, operation: 'rollback' });
    assert.equal(second.cycles[0].commit.status, 'rolled-back'); assert.equal(second.pointer.active, null); assert.equal(second.pointer.generation, 2); assert.equal(calls, 160);
    assert.equal(rows.filter(row => row.observation.split === 'train').length, 48);
    const replay = await new LearningStudyRunner({ ...environment, corpus: policyCorpus(2) }).run({ maxLaunches: 1, batchId: 'batch-0' });
    assert.deepEqual(replay.cycles, first.cycles); assert.equal(calls, 160); assert.equal(replay.pointer.generation, 2);
  } finally { ready.mock.restore(); stream.mock.restore(); close.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});
