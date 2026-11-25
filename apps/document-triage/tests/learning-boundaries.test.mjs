import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { learningCases, learningProductionCase, learningInputDigest, learningCase } from '../dist/learning-corpus.js';
import { openLearningSession } from '../dist/learning-session.js';
import { performLearningCycle } from '../dist/learning-matrix.js';
import { learningDigest, buildSnapshot, DEFAULT_LEARNING_POLICY } from 'hiveagents-runtime/routing/learning';

test('production data cannot consume any current or future protected corpus task', () => {
  const protectedTasks = new Set();
  for (const suite of ['mixed', 'document']) {
    for (const split of ['train', 'fixed']) for (const c of learningCases(split, suite)) protectedTasks.add(learningInputDigest(c.prompt));
    for (let round = 0; round < 3; round++) for (const c of learningCases('fresh', suite, round)) protectedTasks.add(learningInputDigest(c.prompt));
  }
  for (const kind of ['classification', 'arithmetic']) for (const seed of [0, 1, 10, 20, 811, 100000]) {
    assert.equal(protectedTasks.has(learningInputDigest(learningProductionCase({ kind, seed }).prompt)), false);
  }
});

test('controlled good fixture outcomes match the independent manual classification oracle', () => {
  const fixture = new URL('./fixtures/learning-cli.mjs', import.meta.url).pathname;
  for (let seed = 0; seed < 30; seed++) {
    const item = learningCase({ kind: 'classification', seed });
    const result = spawnSync(process.execPath, [fixture, 'claude', '--model', 'claude-sonnet-5', '--session-id', 'fixture'],
      { input: item.prompt, encoding: 'utf8', env: { ...process.env, OAR_LEARNING_FIXTURE_MODE: 'normal', OAR_LEARNING_CALLS: '' } });
    assert.equal(result.status, 0, result.stderr);
    const terminal = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(JSON.parse(terminal.result).answer, item.expected, `manual case ${seed}`);
  }
});

test('changing the protected suite changes the durable protocol domain', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'oar-learning-domains-'));
  const common = { definition: { model: 'codex/gpt-5.6-sol' }, stateDirectory };
  try {
    const mixed = await openLearningSession({ ...common, suite: 'mixed' });
    const document = await openLearningSession({ ...common, suite: 'document' });
    try { assert.notEqual(mixed.domain, document.domain); assert.notEqual(mixed.protocolDigest, document.protocolDigest); }
    finally { mixed.store.close(); document.store.close(); }
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test('matrix stops on a post-terminal infrastructure error without spending on another cell', async () => {
  let starts = 0;
  const failure = new Error('shadow persistence failed');
  const session = { definition: {}, domain: 'domain', timeoutMs: 1000,
    router: { inspect: async () => ({ generation: 0, active: null, previous: null }),
      preflight: async () => ({ actions: [{ id: 'one', key: 'one' }] }), run: async () => { starts++; throw failure; } },
    store: { get: async (kind) => kind === 'observation' && starts > 0 ? { outcome: 'completed' } : undefined } };
  await assert.rejects(performLearningCycle(session, {}, {}, { suite: 'mixed', operation: 'promote' }), error => error === failure);
  assert.equal(starts, 1);
});

test('cycle reports use separate domain namespaces even when both domains start at round zero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-learning-reports-'));
  await mkdir(join(directory, 'learning'));
  try {
    const reports = [];
    const base = { evidenceScope: 'model', model: 'codex/test', provider: 'codex', modelId: 'test', optionsDigest: 'c'.repeat(64), executionDigest: 'd'.repeat(64) };
    const action = { ...base, id: 'one', key: learningDigest(base) };
    for (const domain of ['a'.repeat(64), 'b'.repeat(64)]) {
      const records = new Map();
      const session = { directory, domain, protocolDigest: 'e'.repeat(64), definition: {}, timeoutMs: 1000,
        router: { inspect: async () => ({ generation: 0, active: null, previous: null }),
          preflight: async () => ({ actions: [action], definitionDigest: 'f'.repeat(64) }),
          run: async (_definition, context) => ({ observation: { action, taskDigest: context.task.inputDigest, quality: { state: 'verified', passed: true } } }),
          shadow: async () => buildSnapshot(domain, DEFAULT_LEARNING_POLICY, 0, [], Date.now()),
          improve: async () => ({ status: 'kept' }) },
        store: { get: async (kind, id) => records.get(`${kind}:${id}`), highWater: async () => 0,
          put: async (kind, id, value) => records.set(`${kind}:${id}`, value) } };
      const result = await performLearningCycle(session, {}, { admitted: 0 }, { suite: 'mixed', operation: 'promote' });
      reports.push(result.reportPath);
      assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).gate.status, 'kept');
    }
    assert.notEqual(reports[0], reports[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
