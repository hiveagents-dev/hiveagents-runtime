import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Runtime } from 'hiveagents-runtime';
import { LearningRouter, SqliteLearningStore, learningDomainDigest } from 'hiveagents-runtime/routing/learning';
import { LearningStudyRunner } from '../dist/learning-study.js';

const task = (id) => ({ id, text: `Classify arbitrary task ${id}. Return JSON number 1.`, expected: 1 });
const corpus = (banks = 1, overrides = {}) => ({ format: 1, id: 'continuous-test', oracle: 'json-exact-v1',
  study: { maxCycles: 4, maxLaunches: 100, minNewTasks: 2, ...overrides }, evaluation: { repetitions: 2 },
  train: [task('train')], fixed: [task('fixed')], freshBatches: Array.from({ length: banks }, (_, n) => ({ id: `batch${n}`, tasks: Array.from({ length: 6 }, (_, i) => task(`fresh${n}-${i}`)) })) });
async function sandbox(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'study-coordinator-'));
  const evidence = new SqliteLearningStore(join(directory, 'evidence.sqlite'));
  let calls = 0, held = 0, version = '1';
  const ready = mock.method(Agent.prototype, 'ready', async function () { return { ready: true, model: this.model, provider: this.model.provider,
    auth: { authenticated: true, source: 'subscription' }, installation: { installed: true }, capabilities: { unsupported: [], transport: 'exec' },
    plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: version, executableRealpath: '/fixture' }, capabilities: {}, envelope: { filesystem: { readonlyRoots: [process.cwd()], writableRoots: [] } }, warnings: [] } }; });
  const stream = mock.method(Agent.prototype, 'stream', async function* () {
    calls++; yield { type: 'turn.completed', turn: { status: 'completed', session: { provider: 'codex', model: 'gpt-5.4' }, text: '1', events: [], warnings: [], providerMetadata: {} } };
  });
  const close = mock.method(Agent.prototype, 'close', async () => {});
  const domainObject = { id: 'continuous-test', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
  const routedStore = Object.fromEntries(['get','put','observations','highWater','pointer','appendObservation','commitGate','pending','close'].map(name => [name, (...args) => evidence[name](...args)]));
  const router = new LearningRouter({ store: routedStore, domain: domainObject, policy: { minSimilarity: .5, alpha: .05 / 4 } });
  const environment = { directory, domain: learningDomainDigest(domainObject), protocolDigest: domainObject.protocolDigest,
    definition: { model: 'codex/gpt-5.4', transport: 'exec' }, timeoutMs: 60000, runtime: new Runtime(), router, evidence,
    corpus: corpus(), budget: { acquire() { held++; if (held !== 1) throw new Error('nested budget'); return { release() { held--; } }; } }, ...options };
  try { await run({ environment, directory, evidence, router, calls: () => calls, held: () => held, setVersion: value => { version = value; } }); }
  finally { ready.mock.restore(); stream.mock.restore(); close.mock.restore(); evidence.close(); await rm(directory, { recursive: true, force: true }); }
}

test('chunks resume the same cycle, calibrate once, append four batches and explicitly replay without turns', () => sandbox(async ({ environment, calls }) => {
  let runner = new LearningStudyRunner(environment);
  const paused = await runner.run({ maxLaunches: 3 });
  assert.equal(paused.status, 'paused'); assert.equal(paused.invocationAttempts, 3); assert.equal(calls(), 3);
  runner = new LearningStudyRunner(environment);
  const completed = await runner.run({ maxLaunches: 100 });
  assert.equal(completed.status, 'completed'); assert.equal(completed.cycles.length, 1); assert.equal(calls(), 15);
  assert.equal(completed.admittedAttempts, 15);
  const first = completed.cycles[0];
  assert.equal(first.expectedCells, 14); assert.equal(first.terminalCells, 14); assert.equal(first.verifiedCells, 14);
  assert.equal(first.gate.configDigest.length, 64);
  for (let banks = 2; banks <= 4; banks++) {
    runner = new LearningStudyRunner({ ...environment, corpus: corpus(banks) });
    const next = await runner.run({ maxLaunches: 100 });
    assert.equal(next.status, 'completed'); assert.equal(next.baseDigest, completed.baseDigest); assert.equal(next.domain, completed.domain);
    assert.equal(calls(), 1 + 14 * banks); assert.equal(next.registeredBatches.length, banks);
  }
  const replay = await runner.run({ maxLaunches: 1, batchId: 'batch0' });
  assert.equal(replay.status, 'completed'); assert.equal(replay.invocationAttempts, 0); assert.deepEqual(replay.cycles, [first]); assert.equal(calls(), 57);
  assert.equal((await runner.run({ maxLaunches: 1 })).status, 'exhausted');
}));

test('production task id replay, prompt identity and append collision are durable', () => sandbox(async ({ environment, calls }) => {
  const runner = new LearningStudyRunner(environment), item = task('production');
  const first = await runner.runTask({ task: item, maxLaunches: 1 });
  assert.equal(first.status, 'completed'); assert.equal(first.turn.text, '1');
  const replay = await runner.runTask({ task: item, maxLaunches: 1 });
  assert.equal(replay.status, 'replayed'); assert.equal(replay.turn, undefined); assert.equal(calls(), 1);
  await assert.rejects(runner.runTask({ task: { ...item, expected: 2 }, maxLaunches: 1 }), /input|identity|expected/i);
  const appended = corpus(2); appended.freshBatches[1].tasks[0] = item;
  await assert.rejects(new LearningStudyRunner({ ...environment, corpus: appended }).run({ maxLaunches: 1 }), /collision|production|training/i);
  await assert.rejects(runner.runTask({ task: { ...environment.corpus.train[0], id: 'bypass' }, maxLaunches: 1 }), /protected/i);
  assert.equal(calls(), 1);
}));

test('failed external acquisition consumes durable admissions and leaves the cell resumable', () => sandbox(async ({ environment, calls }) => {
  const refusal = new Error('external admission refused');
  const runner = new LearningStudyRunner({ ...environment, budget: { acquire() { throw refusal; } } });
  await assert.rejects(runner.run({ maxLaunches: 1 }), error => error === refusal);
  const inspected = await runner.inspect(); assert.equal(inspected.admittedAttempts, 1); assert.equal(calls(), 0);
  const resumed = await new LearningStudyRunner(environment).run({ maxLaunches: 1 });
  assert.equal(resumed.admittedAttempts, 2); assert.equal(calls(), 1);
}));

test('maintenance counts distinct newly verified inputs and releases production ownership before nested maintenance', () => sandbox(async ({ environment, held, calls }) => {
  let runner = new LearningStudyRunner(environment);
  await runner.run({ maxLaunches: 100 });
  runner = new LearningStudyRunner({ ...environment, corpus: corpus(2) });
  assert.equal((await runner.run({ maxLaunches: 20, mode: 'maintenance' })).status, 'deferred');
  const item = task('live-one');
  const first = await runner.runTask({ task: item, maxLaunches: 20, autoImprove: true });
  assert.equal(first.maintenance.status, 'deferred'); assert.equal(held(), 0); assert.equal(calls(), 16);
  await runner.runTask({ task: { ...item, id: 'live-copy' }, maxLaunches: 1 });
  assert.equal((await runner.run({ maxLaunches: 20, mode: 'maintenance' })).status, 'deferred');
  const next = await runner.runTask({ task: task('live-two'), maxLaunches: 20, autoImprove: true });
  assert.equal(next.maintenance.status, 'completed'); assert.equal(held(), 0); assert.equal(calls(), 32);
}));

test('immutable generation-zero binding rejects native identity drift and changed registry', () => sandbox(async ({ environment, setVersion, calls }) => {
  const runner = new LearningStudyRunner(environment); await runner.run({ maxLaunches: 1 });
  setVersion('2'); await assert.rejects(runner.run({ maxLaunches: 1 }), /identity|binding|incompatible/i); assert.equal(calls(), 1);
  setVersion('1'); const changed = corpus(); changed.freshBatches[0].tasks[0].expected = 2;
  await assert.rejects(new LearningStudyRunner({ ...environment, corpus: changed }).run({ maxLaunches: 1 }), /prefix|batch|registry/i);
}));

test('pending native start blocks all new cells and inspection never probes models', () => sandbox(async ({ environment, evidence, calls }) => {
  const original = evidence.appendObservation.bind(evidence), failure = new Error('terminal persistence failed');
  evidence.appendObservation = async () => { throw failure; };
  const runner = new LearningStudyRunner(environment);
  await assert.rejects(runner.run({ maxLaunches: 1 }), error => error === failure);
  evidence.appendObservation = original;
  const pending = await evidence.pending(environment.domain); assert.equal(pending.length, 1);
  const inspected = await runner.inspect(); assert.equal(inspected.status, 'blocked'); assert.deepEqual(inspected.pendingAttemptIds, pending.map(p => p.id));
  const resumed = await runner.run({ maxLaunches: 10 }); assert.equal(resumed.status, 'blocked'); assert.equal(resumed.invocationAttempts, 0); assert.equal(calls(), 1);
}));

test('lease remains held through cancelled provider drainage and serializes production with registration', () => sandbox(async ({ environment, calls }) => {
  let entered, unblock;
  const started = new Promise(resolve => { entered = resolve; }), drainage = new Promise(resolve => { unblock = resolve; });
  const replacement = mock.method(Agent.prototype, 'stream', async function* () { entered(); await drainage; yield { type: 'turn.completed', turn: { status: 'completed', session: { provider: 'codex', model: 'gpt-5.4' }, text: '1', events: [], warnings: [], providerMetadata: {} } }; });
  const runner = new LearningStudyRunner(environment), controller = new AbortController();
  const work = runner.runTask({ task: task('slow-live'), maxLaunches: 1, signal: controller.signal });
  const rejected = assert.rejects(work); await started; controller.abort();
  const status = await runner.inspect(); assert.equal(status.status, 'blocked'); assert.ok(status.owner);
  await assert.rejects(new LearningStudyRunner(environment).run({ maxLaunches: 1 }), /already owned/);
  unblock(); await rejected; replacement.mock.restore();
  assert.equal((await runner.inspect()).owner, undefined); assert.equal(calls(), 0);
}));

test('gate commit recovery repairs the journal and returns the original report without redispatch', () => sandbox(async ({ environment, calls, directory }) => {
  const runner = new LearningStudyRunner(environment), original = environment.router.improve.bind(environment.router), lost = new Error('lost commit response');
  environment.router.improve = async options => { await original(options); throw lost; };
  await assert.rejects(runner.run({ maxLaunches: 100 }), error => error === lost); assert.equal(calls(), 15);
  environment.router.improve = original;
  const resumed = await runner.run({ maxLaunches: 1 }); assert.equal(resumed.status, 'completed'); assert.equal(resumed.invocationAttempts, 0); assert.equal(calls(), 15);
  assert.deepEqual((await runner.run({ maxLaunches: 1, batchId: 'batch0' })).cycles, resumed.cycles);
  const { readdir, readFile } = await import('node:fs/promises');
  const files = await readdir(join(directory, 'learning-study'));
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const text = await readFile(join(directory, 'learning-study', file), 'utf8');
    assert.equal(text.includes(environment.corpus.train[0].text), false);
    assert.equal(text.includes('providerMetadata'), false);
  }
}));

test('complete manifests are durably saved before SDK publication and reused after publication failure', () => sandbox(async ({ environment, evidence, directory, calls }) => {
  const original = evidence.put.bind(evidence), failure = new Error('episode store failed'); let expected;
  evidence.put = async (kind, id, row) => {
    if (kind === 'episode') {
      const { readdir, readFile } = await import('node:fs/promises');
      const file = (await readdir(join(directory, 'learning-study'))).find(f => f.endsWith('.json'));
      const checkpoint = JSON.parse(await readFile(join(directory, 'learning-study', file), 'utf8'));
      assert.deepEqual(checkpoint.checkpoint.steps.study.output.cycles[0].fixed, JSON.parse(JSON.stringify(row)));
      expected = row; throw failure;
    }
    return original(kind, id, row);
  };
  const runner = new LearningStudyRunner(environment); await assert.rejects(runner.run({ maxLaunches: 100 }), error => error === failure); assert.equal(calls(), 1);
  evidence.put = original; const resumed = await runner.run({ maxLaunches: 100 });
  assert.equal(calls(), 15); assert.equal(resumed.cycles[0].dataSources.fixedEpisodeDigest, expected.digest);
}));

test('pre-start decision failures reserve another lifetime slot on resume, but terminal release errors remain raw', () => sandbox(async ({ environment, evidence, calls }) => {
  const original = evidence.put.bind(evidence), failure = new Error('decision persisted before response lost'); let once = true;
  evidence.put = async (kind, id, row) => { await original(kind, id, row); if (kind === 'decision' && once) { once = false; throw failure; } };
  const runner = new LearningStudyRunner(environment); await assert.rejects(runner.run({ maxLaunches: 1 }), error => error === failure);
  assert.equal(calls(), 0); assert.equal((await runner.inspect()).admittedAttempts, 1);
  evidence.put = original; const resumed = await runner.run({ maxLaunches: 1 }); assert.equal(resumed.admittedAttempts, 2); assert.equal(calls(), 1);
  const releaseFailure = new Error('raw native release failure');
  const withFailure = new LearningStudyRunner({ ...environment, budget: { acquire() { return { release() { throw releaseFailure; } }; } } });
  await assert.rejects(withFailure.runTask({ task: task('release-failure'), maxLaunches: 1 }), error => error === releaseFailure);
  const replay = await runner.runTask({ task: task('release-failure'), maxLaunches: 1 }); assert.equal(replay.status, 'replayed'); assert.equal(calls(), 2);
}));

test('known full plan, family policy and Cartesian caps reject before acquisition', () => sandbox(async ({ environment, calls }) => {
  await assert.rejects(new LearningStudyRunner({ ...environment, corpus: corpus(1, { maxLaunches: 14 }) }).run({ maxLaunches: 1 }), /plan.*budget|maxLaunches/);
  const wrong = new LearningRouter({ store: environment.evidence, domain: { id: 'continuous-test', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) }, policy: { minSimilarity: .5, alpha: .05 } });
  await assert.rejects(new LearningStudyRunner({ ...environment, router: wrong }).run({ maxLaunches: 1 }), /alpha|policy/);
  const large = corpus(); large.study.maxLaunches = 10000; large.evaluation.repetitions = 1;
  large.freshBatches[0].tasks = Array.from({ length: 128 }, (_, i) => task(`large-${i}`));
  const definition = { model: { mode: 'auto', allowUnverifiedModels: true, candidates: Array.from({ length: 64 }, (_, i) => ({ id: `arm-${i}`, model: `codex/custom-${i}` })) }, transport: 'exec' };
  await assert.rejects(new LearningStudyRunner({ ...environment, definition, corpus: large }).run({ maxLaunches: 1 }), /Cartesian|4096/);
  for (const batchId of ['', 'bad id', 1]) await assert.rejects(new LearningStudyRunner(environment).run({ maxLaunches: 1, batchId }), /batch ID/);
  await assert.rejects(new LearningStudyRunner(environment).runTask({ task: task('invalid-option'), maxLaunches: 1, autoImprove: 'false' }), /autoImprove/);
  assert.equal(calls(), 0);
}));

test('maintenance defers exhausted admissions and an explicit resume cannot renew the cap', () => sandbox(async ({ environment, calls }) => {
  const bounded = { ...environment, corpus: corpus(1, { maxLaunches: 15 }) };
  const runner = new LearningStudyRunner({ ...bounded, budget: { acquire() { throw new Error('denied'); } } });
  await assert.rejects(runner.run({ maxLaunches: 1 }), /denied/);
  const next = new LearningStudyRunner(bounded);
  const maintenance = await next.run({ maxLaunches: 1, mode: 'maintenance' });
  assert.equal(maintenance.status, 'deferred'); assert.match(maintenance.reason, /budget|admission/);
  const explicit = await next.run({ maxLaunches: 100 }); assert.equal(explicit.status, 'exhausted'); assert.equal(explicit.admittedAttempts, 1); assert.equal(calls(), 0);
}));

test('an unaffordable new production intent cannot poison already funded study cells', () => sandbox(async ({ environment, calls }) => {
  const runner = new LearningStudyRunner({ ...environment, corpus: corpus(1, { maxLaunches: 16 }) });
  await runner.runTask({ task: task('funded-production'), maxLaunches: 1 });
  await assert.rejects(runner.runTask({ task: task('unfunded-production'), maxLaunches: 1 }), /budget/);
  const result = await runner.run({ maxLaunches: 100 }); assert.equal(result.status, 'completed'); assert.equal(calls(), 16);
}));

test('appending a fresh batch rejects failed or pending external training inputs and fails closed at history overflow', () => sandbox(async ({ environment, evidence, calls }) => {
  const runner = new LearningStudyRunner(environment); await runner.run({ maxLaunches: 1 });
  const appended = corpus(2), future = appended.freshBatches[1].tasks[0];
  const { inputDigest } = await import('hiveagents-runtime/routing/learning');
  const failure = new Error('external training failed');
  const replacement = mock.method(Agent.prototype, 'stream', async function* () { throw failure; });
  await assert.rejects(environment.router.run(environment.definition, { runtime: environment.runtime,
    task: { id: 'other-train', version: '1', text: future.text, inputDigest: inputDigest(future.text) }, input: future.text,
    budget: environment.budget, verify: () => ({ value: 1, passed: true }) }), error => error === failure);
  replacement.mock.restore();
  await assert.rejects(new LearningStudyRunner({ ...environment, corpus: appended }).run({ maxLaunches: 1 }), /collision|training/);
  const unrelated = corpus(2); unrelated.freshBatches[1].tasks = unrelated.freshBatches[1].tasks.map((item, i) => task(`unrelated-${i}`));
  const original = evidence.observations.bind(evidence), sample = (await original(environment.domain, { split: 'train' }))[0];
  evidence.observations = async (domain, options) => options?.limit === 10001 ? Array.from({ length: 10001 }, () => sample) : original(domain, options);
  await assert.rejects(new LearningStudyRunner({ ...environment, corpus: unrelated }).run({ maxLaunches: 1 }), /10001|overflow|history/);
  assert.equal(calls(), 1);
}));

test('unknown terminal calibration cells block every later cycle without fabricated recovery', () => sandbox(async ({ environment, calls }) => {
  const failure = new Error('provider refused'); const replacement = mock.method(Agent.prototype, 'stream', async function* () { throw failure; });
  const runner = new LearningStudyRunner(environment); await assert.rejects(runner.run({ maxLaunches: 10 }), error => error === failure); replacement.mock.restore();
  const result = await new LearningStudyRunner({ ...environment, corpus: corpus(2) }).run({ maxLaunches: 10 });
  assert.equal(result.status, 'blocked'); assert.equal(result.activeBatchId, 'batch0'); assert.equal(result.invocationAttempts, 0); assert.equal(result.admittedAttempts, 1); assert.equal(calls(), 0);
}));

test('a checksummed but structurally invalid checkpoint cannot expand immutable policy limits', () => sandbox(async ({ environment, calls }) => {
  const runner = new LearningStudyRunner(environment); await runner.run({ maxLaunches: 1 });
  const { FileWorkflowStore } = await import('hiveagents-runtime/orchestration');
  const { learningDigest } = await import('hiveagents-runtime/routing/learning');
  const store = new FileWorkflowStore(join(environment.directory, 'learning-study'));
  const lease = await store.acquire(`learning-study:${environment.corpus.id}`);
  const checkpoint = await lease.load(); checkpoint.steps.study.output.limits.maxCycles = 64;
  checkpoint.workflow.fingerprint = learningDigest(checkpoint.steps.study.output); await lease.save(checkpoint); await lease.release();
  await assert.rejects(runner.run({ maxLaunches: 1 }), /Corrupt|binding|policy/); assert.equal(calls(), 1);
}));

test('production survives maintenance failure while reporting every failed acquisition admission', () => sandbox(async ({ environment, calls }) => {
  let acquisitions = 0;
  const runner = new LearningStudyRunner({ ...environment, budget: { acquire() { if (++acquisitions > 1) throw new Error('maintenance denied'); return { release() {} }; } } });
  const result = await runner.runTask({ task: task('successful-primary'), maxLaunches: 5, autoImprove: true });
  assert.equal(result.status, 'completed'); assert.equal(result.turn.text, '1'); assert.equal(result.maintenance.status, 'failed');
  assert.equal(result.invocationAttempts, 2); assert.equal(result.admittedAttempts, 2); assert.equal(calls(), 1);
}));

test('failed production acquisition still reserves its input against a later fresh batch', () => sandbox(async ({ environment, calls }) => {
  const item = task('prestart-production'), runner = new LearningStudyRunner({ ...environment, budget: { acquire() { throw new Error('denied'); } } });
  await assert.rejects(runner.runTask({ task: item, maxLaunches: 1 }), /denied/);
  const appended = corpus(2); appended.freshBatches[1].tasks[0] = { ...item, id: 'renamed-fresh' };
  await assert.rejects(new LearningStudyRunner({ ...environment, corpus: appended }).run({ maxLaunches: 1 }), /collision/);
  assert.equal((await runner.inspect()).admittedAttempts, 1); assert.equal(calls(), 0);
}));

test('journal failure at maintenance entry is not swallowed by successful SDK production semantics', () => sandbox(async ({ environment, calls }) => {
  const { FileWorkflowStore } = await import('hiveagents-runtime/orchestration');
  const original = FileWorkflowStore.prototype.acquire, failure = new Error('production metadata save failed');
  const acquire = mock.method(FileWorkflowStore.prototype, 'acquire', async function (...args) {
    const lease = await original.apply(this, args); let saves = 0;
    return { ...lease, async save(value) { if (++saves === 3) throw failure; return lease.save(value); } };
  });
  try {
    const runner = new LearningStudyRunner(environment);
    await assert.rejects(runner.runTask({ task: task('metadata-failure'), maxLaunches: 5, autoImprove: true }), error => error === failure);
    assert.equal(calls(), 1);
  } finally { acquire.mock.restore(); }
}));

test('journal lease release failure at maintenance entry remains the raw error', () => sandbox(async ({ environment, calls }) => {
  const { FileWorkflowStore } = await import('hiveagents-runtime/orchestration');
  const original = FileWorkflowStore.prototype.acquire, failure = new Error('journal release failed');
  const acquire = mock.method(FileWorkflowStore.prototype, 'acquire', async function (...args) {
    const lease = await original.apply(this, args);
    return { ...lease, async release() { await lease.release(); throw failure; } };
  });
  try {
    const runner = new LearningStudyRunner(environment);
    await assert.rejects(runner.runTask({ task: task('journal-release-failure'), maxLaunches: 5, autoImprove: true }), error => error === failure);
    assert.equal(calls(), 1);
  } finally { acquire.mock.restore(); }
}));

test('a separate process owns the same corpus lease across coordinator and production entry points', () => sandbox(async ({ environment, calls }) => {
  const { fork } = await import('node:child_process'); const { once } = await import('node:events');
  const script = `import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';
    const store = new FileWorkflowStore(process.argv[1]); const lease = await store.acquire(process.argv[2]);
    process.send('owned'); process.once('message', async () => { await lease.release(); process.exit(0); });`;
  const child = fork('-e', [script, join(environment.directory, 'learning-study'), `learning-study:${environment.corpus.id}`],
    { execArgv: ['--input-type=module'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await once(child, 'message'); const runner = new LearningStudyRunner(environment);
    const status = await runner.inspect(); assert.equal(status.status, 'blocked'); assert.equal(status.owner.pid, child.pid);
    await assert.rejects(runner.run({ maxLaunches: 1 }), /already owned/);
    await assert.rejects(runner.runTask({ task: task('cross-process'), maxLaunches: 1 }), /already owned/); assert.equal(calls(), 0);
  } finally { const exit = once(child, 'exit'); child.send('release'); await exit; }
}));

test('a durable gate is reportable after later failed production exhausts admission slack', () => sandbox(async ({ environment, calls }) => {
  const bounded = { ...environment, corpus: corpus(1, { maxLaunches: 16 }) }, original = environment.router.improve.bind(environment.router);
  environment.router.improve = async options => { await original(options); throw new Error('stdout lost'); };
  await assert.rejects(new LearningStudyRunner(bounded).run({ maxLaunches: 100 }), /stdout lost/); environment.router.improve = original;
  const production = new LearningStudyRunner({ ...bounded, budget: { acquire() { throw new Error('production denied'); } } });
  await assert.rejects(production.runTask({ task: task('late-denied'), maxLaunches: 1 }), /production denied/);
  const replay = await new LearningStudyRunner(bounded).run({ maxLaunches: 1, batchId: 'batch0' });
  assert.equal(replay.status, 'completed'); assert.equal(replay.cycles.length, 1); assert.equal(replay.invocationAttempts, 0); assert.equal(replay.admittedAttempts, 16); assert.equal(calls(), 15);
}));

test('R1 binding drift inside admission cannot start native work or persist an attempt', () => sandbox(async ({ environment, evidence, calls, setVersion }) => {
  const runner = new LearningStudyRunner({ ...environment, budget: { acquire() { setVersion('changed-during-admission'); return { release() {} }; } } });
  await assert.rejects(runner.run({ maxLaunches: 1 }), /binding|identity/i);
  assert.equal(calls(), 0); assert.equal((await evidence.pending(environment.domain)).length, 0);
  assert.equal((await evidence.observations(environment.domain)).length, 0); assert.equal((await runner.inspect()).admittedAttempts, 1);
}));

test('R1 every production admission checks the complete current action universe', () => sandbox(async ({ environment, calls, setVersion }) => {
  const original = environment.router.run.bind(environment.router);
  environment.router.run = async (...args) => { setVersion('changed-before-budget'); return original(...args); };
  const runner = new LearningStudyRunner(environment);
  await assert.rejects(runner.runTask({ task: task('drift-production'), maxLaunches: 1 }), /binding|identity/i);
  assert.equal(calls(), 0); assert.equal((await runner.inspect()).admittedAttempts, 0);
}));

test('R1 a pending calibration attempt blocks unrelated production without another admission', () => sandbox(async ({ environment, evidence, calls }) => {
  const original = evidence.appendObservation.bind(evidence), failure = new Error('terminal write failed');
  evidence.appendObservation = async () => { throw failure; };
  const runner = new LearningStudyRunner(environment); await assert.rejects(runner.run({ maxLaunches: 1 }), error => error === failure);
  evidence.appendObservation = original; const pending = await evidence.pending(environment.domain);
  const result = await runner.runTask({ task: task('after-pending-calibration'), maxLaunches: 1 });
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.pendingAttemptIds, pending.map(row => row.id));
  assert.equal(result.invocationAttempts, 0); assert.equal(result.admittedAttempts, 1); assert.equal(calls(), 1);
}));

test('R1 named committed recovery returns once even when cycles requests more than one', () => sandbox(async ({ environment, calls }) => {
  const original = environment.router.improve.bind(environment.router);
  environment.router.improve = async options => { await original(options); throw new Error('lost stdout'); };
  const runner = new LearningStudyRunner(environment); await assert.rejects(runner.run({ maxLaunches: 100 }), /lost stdout/);
  environment.router.improve = original;
  const recovered = await runner.run({ maxLaunches: 1, batchId: 'batch0', cycles: 2 });
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.cycles.length, 1); assert.equal(recovered.invocationAttempts, 0); assert.equal(calls(), 15);
}));

test('R1 feedback arriving after the frozen shadow cutoff remains new for the next maintenance cycle', () => sandbox(async ({ environment, calls }) => {
  const initial = { ...environment, corpus: corpus(1, { minNewTasks: 1 }) }, original = environment.router.shadow.bind(environment.router);
  let shadows = 0;
  environment.router.shadow = async (...args) => {
    const frozen = await original(...args);
    if (++shadows === 2) {
      const item = task('concurrent-late-feedback'), { inputDigest } = await import('hiveagents-runtime/routing/learning');
      await environment.router.run(environment.definition, { runtime: environment.runtime, task: { id: item.id, version: '1', text: item.text, inputDigest: inputDigest(item.text) },
        input: item.text, budget: environment.budget, verify: () => ({ value: 1, passed: true }) });
    }
    return frozen;
  };
  await new LearningStudyRunner(initial).run({ maxLaunches: 100 }); assert.equal(calls(), 16);
  environment.router.shadow = original;
  const next = await new LearningStudyRunner({ ...environment, corpus: corpus(2, { minNewTasks: 1 }) }).run({ maxLaunches: 100, mode: 'maintenance' });
  assert.equal(next.status, 'completed'); assert.equal(next.cycles.length, 1); assert.equal(calls(), 30);
}));

test('R1 nested journal acquisition IO remains the original error after SDK maintenance handling', () => sandbox(async ({ environment, calls }) => {
  const { FileWorkflowStore } = await import('hiveagents-runtime/orchestration'), original = FileWorkflowStore.prototype.acquire;
  const failure = new Error('nested journal acquire IO'); let acquisitions = 0;
  const replacement = mock.method(FileWorkflowStore.prototype, 'acquire', async function (...args) {
    if (++acquisitions === 2) throw failure; return original.apply(this, args);
  });
  try {
    await assert.rejects(new LearningStudyRunner(environment).runTask({ task: task('nested-acquire-failure'), maxLaunches: 5, autoImprove: true }), error => error === failure);
    assert.equal(calls(), 1);
  } finally { replacement.mock.restore(); }
}));

test('R2 same-runner contention cannot turn an ordinary maintenance denial into a fatal primary error', () => sandbox(async ({ environment, calls }) => {
  let entered, unblock, acquisitions = 0;
  const maintenanceStarted = new Promise(resolve => { entered = resolve; }), resumeMaintenance = new Promise(resolve => { unblock = resolve; });
  const denied = new Error('ordinary maintenance admission denied');
  const runner = new LearningStudyRunner({ ...environment, budget: { async acquire() {
    if (++acquisitions === 1) return { release() {} };
    entered(); await resumeMaintenance; throw denied;
  } } });
  const primary = runner.runTask({ task: task('concurrent-primary'), maxLaunches: 5, autoImprove: true });
  const settled = primary.then(value => ({ value }), error => ({ error }));
  await maintenanceStarted;
  try { await assert.rejects(runner.run({ maxLaunches: 1 }), /already owned/); }
  finally { unblock(); }
  const outcome = await settled;
  assert.equal(outcome.error, undefined, 'Only this maintenance invocation may attribute its own journal failure');
  assert.equal(outcome.value.status, 'completed'); assert.equal(outcome.value.turn.text, '1');
  assert.equal(outcome.value.maintenance.status, 'failed'); assert.equal(outcome.value.invocationAttempts, 2); assert.equal(outcome.value.admittedAttempts, 2); assert.equal(calls(), 1);
}));
